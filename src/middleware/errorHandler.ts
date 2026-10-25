import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/httpError.js";
import { logServerError } from "../services/telemetry.js";

/** Shown for failures that aren't an HttpError, whose raw text stays in the logs. */
const GENERIC_UPSTREAM_MESSAGE = "Something went wrong on our side — please try again.";

/**
 * A 4xx status set by middleware we don't own — body-parser's malformed JSON
 * (400) and oversized body (413) errors carry `status` / `statusCode`.
 */
function clientErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const { status, statusCode } = err as { status?: unknown; statusCode?: unknown };
  const value = typeof status === "number" ? status : statusCode;
  return typeof value === "number" && value >= 400 && value < 500 ? value : null;
}

/**
 * Central error handler. Keeps upstream failures from crashing the process and
 * returns a consistent JSON error envelope. Express identifies this as the
 * error handler by its four-argument signature. HttpError instances keep their
 * status and message; framework 4xx errors keep their status; anything else
 * is treated as an upstream failure (502) whose message is logged but not
 * sent, since it can carry database or third-party internals.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  const status =
    err instanceof HttpError ? err.status : (clientErrorStatus(err) ?? 502);
  console.error("[error]", message);
  // 4xx are the caller's mistake; 5xx are ours and go to the admin Insights tab.
  if (status >= 500) {
    logServerError(
      message,
      `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`,
      err instanceof Error ? err.stack : undefined,
    );
  }
  if (res.headersSent) return;
  // Admin routes run behind requireAdmin, and their setup hints ("run
  // supabase/quiz-engine.sql?") live in these messages — keep them there.
  const exposed =
    err instanceof HttpError || req.baseUrl.startsWith("/api/admin")
      ? message
      : status < 500
        ? "The request could not be read."
        : GENERIC_UPSTREAM_MESSAGE;
  res.status(status).json({
    error: status === 502 ? "Upstream Error" : "Request Failed",
    message: exposed,
  });
}
