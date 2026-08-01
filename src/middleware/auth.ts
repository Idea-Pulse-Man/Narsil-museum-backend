/**
 * Supabase-backed auth for checkout routes. The app sends its session's access
 * token as `Authorization: Bearer <jwt>`; we verify it with the service-role
 * client and stash the user on the request.
 */
import type { NextFunction, Request, Response } from "express";
import type { AuthedUser } from "../services/checkout.js";
import { supabaseAdmin } from "../services/supabaseAdmin.js";

/** Read the verified user a `requireUser`-guarded handler runs for. */
export function authedUser(req: Request): AuthedUser {
  const user = (req as Request & { user?: AuthedUser }).user;
  if (!user) throw new Error("authedUser called on an unguarded route");
  return user;
}

/**
 * Read the user on a route guarded by `optionalUser` — null when the caller is
 * anonymous. Use `authedUser` instead on `requireUser` routes.
 */
export function maybeUser(req: Request): AuthedUser | null {
  return (req as Request & { user?: AuthedUser }).user ?? null;
}

/**
 * Resolve the user when a token is present, but let anonymous callers through.
 *
 * For routes that serve everyone and only vary what they return — the download
 * endpoint gives a standard image to anyone and the high-resolution one to
 * Narsil Pro members. A bad or expired token is treated as anonymous rather
 * than as an error, so a stale session degrades to the free tier instead of
 * breaking the download entirely.
 */
export async function optionalUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token) {
      const { data } = await supabaseAdmin().auth.getUser(token);
      if (data?.user) {
        (req as Request & { user?: AuthedUser }).user = {
          id: data.user.id,
          email: data.user.email ?? undefined,
        };
      }
    }
  } catch {
    // Anonymous — the route decides what an unauthenticated caller may have.
  }
  next();
}

/** Shown when no token was sent and the route didn't say what it's for. */
const DEFAULT_SIGN_IN_MESSAGE = "Sign in to continue.";

async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
  signInMessage: string,
): Promise<void> {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      res.status(401).json({ error: "Unauthorized", message: signInMessage });
      return;
    }

    const { data, error } = await supabaseAdmin().auth.getUser(token);
    if (error || !data.user) {
      // An expired session reads the same whatever the route was for, so this
      // one stays generic.
      res.status(401).json({
        error: "Unauthorized",
        message: "Your session has expired — sign in again.",
      });
      return;
    }

    (req as Request & { user?: AuthedUser }).user = {
      id: data.user.id,
      email: data.user.email ?? undefined,
    };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * `requireUser` with route-specific copy for the signed-out case.
 *
 * The app surfaces these messages directly in toasts, so a single hardcoded
 * string means someone tapping a high-resolution download gets told to sign in
 * "to order a canvas". Pass what the caller was actually trying to do.
 */
export function requireUserFor(signInMessage: string) {
  return (req: Request, res: Response, next: NextFunction): Promise<void> =>
    authenticate(req, res, next, signInMessage);
}

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return authenticate(req, res, next, DEFAULT_SIGN_IN_MESSAGE);
}

/**
 * `requireUser` plus a `profiles.role = 'admin'` check. Mount it on admin-only
 * routes; the role is read with the service-role client so RLS can't be used to
 * spoof it, and `profiles.role` itself is only writable by the admin RPCs (see
 * museum-app/supabase/admin-dashboard.sql).
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await requireUser(req, res, async (err?: unknown) => {
    // requireUser either answered 401 itself (callback never runs) or handed us
    // an error to propagate.
    if (err) {
      next(err);
      return;
    }
    try {
      const { id } = authedUser(req);
      const { data, error } = await supabaseAdmin()
        .from("profiles")
        .select("role")
        .eq("id", id)
        .maybeSingle();
      if (error) {
        res.status(502).json({
          error: "Bad Gateway",
          message: `Could not verify admin access: ${error.message}`,
        });
        return;
      }
      if (data?.role !== "admin") {
        res.status(403).json({
          error: "Forbidden",
          message: "Admin access required.",
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  });
}
