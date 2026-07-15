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

export async function requireUser(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) {
      res.status(401).json({
        error: "Unauthorized",
        message: "Sign in to order a canvas.",
      });
      return;
    }

    const { data, error } = await supabaseAdmin().auth.getUser(token);
    if (error || !data.user) {
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
