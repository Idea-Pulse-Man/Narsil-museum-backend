/**
 * Turns a saved app address (free-text fields) into the strict recipient shape
 * Printful requires (ISO country_code, state_code for US/CA/AU). Validation
 * runs BEFORE the PaymentIntent is created so an undeliverable address fails
 * fast instead of after the customer has paid.
 */
import { HttpError } from "../utils/httpError.js";
import type { PrintfulRecipient } from "./printful.js";

export interface AddressRow {
  id: string;
  label: string | null;
  recipient_name: string | null;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
}

/** Common country spellings → ISO 3166-1 alpha-2 (2-letter input passes through). */
const COUNTRY_CODES: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  america: "US",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  england: "GB",
  canada: "CA",
  australia: "AU",
  germany: "DE",
  deutschland: "DE",
  france: "FR",
  spain: "ES",
  italy: "IT",
  netherlands: "NL",
  belgium: "BE",
  switzerland: "CH",
  austria: "AT",
  ireland: "IE",
  portugal: "PT",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  poland: "PL",
  japan: "JP",
  "south korea": "KR",
  korea: "KR",
  china: "CN",
  india: "IN",
  brazil: "BR",
  mexico: "MX",
  "new zealand": "NZ",
  singapore: "SG",
  "hong kong": "HK",
  taiwan: "TW",
  "united arab emirates": "AE",
  uae: "AE",
};

const US_STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR",
  california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND",
  ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
  "puerto rico": "PR",
};

function toCountryCode(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_CODES[trimmed.toLowerCase()] ?? null;
}

function toStateCode(value: string, countryCode: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z]{2,3}$/.test(trimmed)) return trimmed.toUpperCase();
  if (countryCode === "US") return US_STATES[trimmed.toLowerCase()] ?? null;
  return null;
}

/** Countries whose Printful orders must carry a state_code. */
const STATE_REQUIRED = new Set(["US", "CA", "AU"]);

export function buildRecipient(
  address: AddressRow,
  email: string | undefined,
): PrintfulRecipient {
  if (!address.line1?.trim()) {
    throw new HttpError(400, "The delivery address needs a street line.");
  }
  if (!address.city?.trim()) {
    throw new HttpError(400, "The delivery address needs a city.");
  }

  const countryCode = toCountryCode(address.country ?? "");
  if (!countryCode) {
    throw new HttpError(
      400,
      'Unrecognised delivery country — use a 2-letter code like "US" or "GB".',
    );
  }

  const stateCode = toStateCode(address.region ?? "", countryCode);
  if (STATE_REQUIRED.has(countryCode) && !stateCode) {
    throw new HttpError(
      400,
      'This country needs a state/province — add a 2-letter code (e.g. "NY") to the address.',
    );
  }

  if (!address.postal_code?.trim()) {
    throw new HttpError(400, "The delivery address needs a postal code.");
  }

  return {
    name: address.recipient_name?.trim() || address.label?.trim() || "Narsil customer",
    address1: address.line1.trim(),
    ...(address.line2?.trim() ? { address2: address.line2.trim() } : {}),
    city: address.city.trim(),
    ...(stateCode ? { state_code: stateCode } : {}),
    country_code: countryCode,
    zip: address.postal_code.trim(),
    ...(address.phone?.trim() ? { phone: address.phone.trim() } : {}),
    ...(email ? { email } : {}),
  };
}
