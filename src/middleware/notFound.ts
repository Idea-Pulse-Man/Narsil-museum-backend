import type { Request, Response } from "express";

/** Uniform 404 for unmatched routes. */
export function notFound(req: Request, res: Response): void {
  res.status(404).json({
    error: "Not Found",
    message: `No route for ${req.method} ${req.originalUrl}`,
  });
}
