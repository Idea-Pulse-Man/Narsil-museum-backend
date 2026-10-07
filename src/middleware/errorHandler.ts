import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/httpError.js";
import { logServerError } from "../services/telemetry.js";

/**
 * Central error handler. Keeps upstream failures from crashing the process and
 * returns a consistent JSON error envelope. Express identifies this as the
 * error handler by its four-argument signature. HttpError instances keep their
 * status; anything else is treated as an upstream failure (502).
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  const status = err instanceof HttpError ? err.status : 502;
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
  res.status(status).json({
    error: status === 502 ? "Upstream Error" : "Request Failed",
    message,
  });
}
