import { describe, expect, it } from "vitest";
import { buildRecipient, type AddressRow } from "./recipient.js";

const US: AddressRow = {
  id: "a1",
  label: "Home",
  recipient_name: "Ada Lovelace",
  phone: null,
  line1: "350 5th Ave",
  line2: null,
  city: "New York",
  region: "New York",
  postal_code: "10118",
  country: "United States",
};

describe("buildRecipient", () => {
  it("normalises a US address to Printful's codes", () => {
    expect(buildRecipient(US, "ada@example.com")).toEqual({
      name: "Ada Lovelace",
      address1: "350 5th Ave",
      city: "New York",
      state_code: "NY",
      country_code: "US",
      zip: "10118",
      email: "ada@example.com",
    });
  });

  it("refuses addresses outside the US", () => {
    expect(() =>
      buildRecipient(
        { ...US, country: "GB", region: "London", postal_code: "SW1A 1AA" },
        undefined,
      ),
    ).toThrow("US addresses only");
  });

  it("requires a valid state", () => {
    expect(() => buildRecipient({ ...US, region: "Atlantis" }, undefined)).toThrow(/state/);
  });

  it("requires a street, city and postal code", () => {
    expect(() => buildRecipient({ ...US, line1: " " }, undefined)).toThrow(/street/);
    expect(() => buildRecipient({ ...US, city: null }, undefined)).toThrow(/city/);
    expect(() => buildRecipient({ ...US, postal_code: "" }, undefined)).toThrow(/postal code/);
  });
});
