import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../utils/httpError.js";

/**
 * Central error handler. Keeps upstream failures from crashing the process and
 * returns a consistent JSON error envelope. Express identifies this as the
 * error handler by its four-argument signature. HttpError instances keep their
 * status; anything else is treated as an upstream failure (502).
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  const status = err instanceof HttpError ? err.status : 502;
  console.error("[error]", message);
  if (res.headersSent) return;
  res.status(status).json({
    error: status === 502 ? "Upstream Error" : "Request Failed",
    message,
  });
}
