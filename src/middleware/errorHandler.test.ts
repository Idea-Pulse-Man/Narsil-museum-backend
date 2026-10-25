import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/telemetry.js", () => ({ logServerError: vi.fn() }));

import { errorHandler } from "./errorHandler.js";
import { HttpError } from "../utils/httpError.js";

function run(err: unknown, baseUrl = "/api/checkout") {
  const res = {
    headersSent: false,
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  const req = { method: "POST", baseUrl, path: "/x" } as unknown as Request;
  errorHandler(err, req, res as unknown as Response, () => {});
  return res as { statusCode: number; body: { message: string } };
}

describe("errorHandler", () => {
  it("keeps HttpError status and message", () => {
    const res = run(new HttpError(409, "Order already paid."));
    expect(res.statusCode).toBe(409);
    expect(res.body.message).toBe("Order already paid.");
  });

  it("keeps body-parser 4xx statuses instead of reporting 502", () => {
    const parseError = Object.assign(new SyntaxError("Unexpected token } in JSON"), {
      status: 400,
    });
    expect(run(parseError).statusCode).toBe(400);
    const tooLarge = Object.assign(new Error("request entity too large"), { statusCode: 413 });
    expect(run(tooLarge).statusCode).toBe(413);
  });

  it("hides internal messages on public routes but not on admin routes", () => {
    const internal = new Error('relation "canvas_orders" does not exist');
    const pub = run(internal);
    expect(pub.statusCode).toBe(502);
    expect(pub.body.message).not.toContain("canvas_orders");
    expect(run(internal, "/api/admin").body.message).toContain("canvas_orders");
  });
});
