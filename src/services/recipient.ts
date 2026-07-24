/**
 * Turns a saved app address (free-text fields) into the strict recipient shape
 * Printful requires (ISO country_code, state_code for US/CA/AU). Validation
 * runs BEFORE the PaymentIntent is created so an undeliverable address fails
 * fast instead of after the customer has paid.
 *
 * The app now picks codes from dropdowns (museum-app `lib/countries.ts`), so
 * most input arrives already correct. This stays the authority: codes are
 * checked against the real ISO/subdivision sets rather than a shape test, so a
 * plausible-looking "XX" can't slip through and strand a paid order in
 * fulfillment_failed. Names are still accepted for rows saved before the
 * dropdowns existed.
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

/** Every ISO 3166-1 alpha-2 country code. */
const COUNTRY_CODES = new Set(
  ("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ " +
    "BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR " +
    "CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU " +
    "ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ " +
    "LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ " +
    "MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF " +
    "PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI " +
    "SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR " +
    "TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

/** Country spellings people type → ISO alpha-2. Codes are preferred. */
const COUNTRY_BY_NAME: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  america: "US",
  "united kingdom": "GB",
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  canada: "CA",
  australia: "AU",
  germany: "DE",
  deutschland: "DE",
  france: "FR",
  spain: "ES",
  italy: "IT",
  netherlands: "NL",
  holland: "NL",
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
  greece: "GR",
  czechia: "CZ",
  "czech republic": "CZ",
  romania: "RO",
  hungary: "HU",
  ukraine: "UA",
  russia: "RU",
  "russian federation": "RU",
  turkey: "TR",
  türkiye: "TR",
  israel: "IL",
  japan: "JP",
  "south korea": "KR",
  korea: "KR",
  china: "CN",
  india: "IN",
  brazil: "BR",
  mexico: "MX",
  argentina: "AR",
  chile: "CL",
  colombia: "CO",
  "new zealand": "NZ",
  singapore: "SG",
  "hong kong": "HK",
  taiwan: "TW",
  thailand: "TH",
  vietnam: "VN",
  philippines: "PH",
  indonesia: "ID",
  malaysia: "MY",
  "south africa": "ZA",
  egypt: "EG",
  nigeria: "NG",
  kenya: "KE",
  "saudi arabia": "SA",
  "united arab emirates": "AE",
  uae: "AE",
};

/**
 * Countries whose Printful orders must carry a state_code, with the codes each
 * one accepts. Membership here is what makes the state_code required.
 */
const SUBDIVISIONS: Record<string, Set<string>> = {
  US: new Set(
    ("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN " +
      "MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA " +
      "WV WI WY AS GU MP PR VI AA AE AP"
    ).split(" "),
  ),
  CA: new Set("AB BC MB NB NL NT NS NU ON PE QC SK YT".split(" ")),
  AU: new Set("ACT NSW NT QLD SA TAS VIC WA".split(" ")),
};

/** US state names → code, for addresses saved before the dropdowns. */
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
  const upper = trimmed.toUpperCase();
  if (COUNTRY_CODES.has(upper)) return upper;
  return COUNTRY_BY_NAME[trimmed.toLowerCase()] ?? null;
}

function toStateCode(value: string, countryCode: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const codes = SUBDIVISIONS[countryCode];
  // Country doesn't need a state_code — pass the customer's wording through.
  if (!codes) return trimmed;

  const upper = trimmed.toUpperCase();
  if (codes.has(upper)) return upper;
  if (countryCode === "US") {
    const named = US_STATES[trimmed.toLowerCase()];
    if (named) return named;
  }
  return null;
}

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
      'Unrecognised delivery country — use a 2-letter ISO code like "US" or "GB".',
    );
  }

  const stateCode = toStateCode(address.region ?? "", countryCode);
  if (countryCode in SUBDIVISIONS && !stateCode) {
    throw new HttpError(
      400,
      `A valid ${countryCode} state/province code is required (e.g. ${[
        ...SUBDIVISIONS[countryCode],
      ]
        .slice(0, 3)
        .join(", ")}).`,
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
