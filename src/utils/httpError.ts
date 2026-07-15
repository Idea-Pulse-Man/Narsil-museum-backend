/**
 * Error carrying an HTTP status so route handlers and services can throw once
 * and let the central errorHandler shape the JSON response.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
