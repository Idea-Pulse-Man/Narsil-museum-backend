import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signApnsJwt } from "./push.js";

describe("signApnsJwt", () => {
  it("produces an ES256 JWT that verifies with the key's public half", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const jwt = signApnsJwt(pem, "ABC123DEFG", "TEAM123456", 1_700_000_000);
    const [h, c, s] = jwt.split(".");

    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "ABC123DEFG",
    });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: 1_700_000_000,
    });
    const sig = Buffer.from(s, "base64url");
    expect(sig.length).toBe(64); // raw r||s, as APNs requires
    expect(
      verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig),
    ).toBe(true);
  });
});
