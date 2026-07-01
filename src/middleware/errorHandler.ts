import type { NextFunction, Request, Response } from "express";

/**
 * Central error handler. Keeps upstream failures from crashing the process and
 * returns a consistent JSON error envelope. Express identifies this as the
 * error handler by its four-argument signature.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = err instanceof Error ? err.message : "Unknown error";
  console.error("[error]", message);
  if (res.headersSent) return;
  res.status(502).json({
    error: "Upstream Error",
    message,
  });
}
