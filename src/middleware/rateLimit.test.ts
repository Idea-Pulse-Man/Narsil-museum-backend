import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rateLimit } from "./rateLimit.js";

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    statusCode: 200,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

const req = (ip: string) => ({ ip, socket: {} }) as unknown as Request;
const asRes = (res: ReturnType<typeof fakeRes>) => res as unknown as Response;

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimit", () => {
  it("lets `max` requests through, then answers 429 with Retry-After", () => {
    const limit = rateLimit({ windowMs: 60_000, max: 3, message: "slow down" });
    const next = vi.fn() as unknown as NextFunction;
    for (let i = 0; i < 3; i++) limit(req("1.1.1.1"), asRes(fakeRes()), next);
    expect(next).toHaveBeenCalledTimes(3);

    const blocked = fakeRes();
    limit(req("1.1.1.1"), asRes(blocked), next);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toEqual({ error: "Too Many Requests", message: "slow down" });
    expect(Number(blocked.headers["Retry-After"])).toBeGreaterThan(0);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it("counts each client separately and resets after the window", () => {
    vi.useFakeTimers();
    const limit = rateLimit({ windowMs: 1_000, max: 1, message: "x" });
    const next = vi.fn() as unknown as NextFunction;
    limit(req("1.1.1.1"), asRes(fakeRes()), next);
    limit(req("2.2.2.2"), asRes(fakeRes()), next);
    expect(next).toHaveBeenCalledTimes(2);

    const blocked = fakeRes();
    limit(req("1.1.1.1"), asRes(blocked), next);
    expect(blocked.statusCode).toBe(429);

    vi.advanceTimersByTime(1_001);
    limit(req("1.1.1.1"), asRes(fakeRes()), next);
    expect(next).toHaveBeenCalledTimes(3);
  });
});
