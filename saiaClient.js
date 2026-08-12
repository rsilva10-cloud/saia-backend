/**
 * saiaClient.js
 * -------------
 * Wrapper around Saia's real freight API.
 *
 * Scope: Saia's self-service API only covers Rate Quote, Tracking, Bill of
 * Lading, and Imaging — there is no pickup-booking API. Pickups are booked
 * manually (Saia's site/phone/email) and the PRO number is entered by hand
 * into the PO tool, which then uses it to pull live tracking status.
 *
 * RATE QUOTE — fully confirmed from the real OpenAPI spec for the
 * "REST Rate Quote Customer API":
 *   Server:  https://dev-api.saia.com/rate-quote   (dev/test environment)
 *   Path:    POST /webservice/ratequote/customer-api   ("Customer API -
 *            Quote Request" — NOT the sibling "/api/v1/rate-quote/web-api"
 *            operation in the same spec, which is Saia's internal web-app
 *            quote tool and expects a different, unrelated payload shape)
 *   Header:  RQ-Key: <your subscription key>
 *   Body:
 *     {
 *       userID, password,              <- real Saia account login, server-side only
 *       payer,                         <- e.g. "Shipper" (exact accepted values still unconfirmed)
 *       pickUpDate,                    <- optional, e.g. "2023-11-01"
 *       origin:      { accountCode?, city, state, zipcode },
 *       destination: { accountCode?, city, state, zipcode },
 *       thirdPartyDetails: { accountCode },   <- only relevant if payer is "Third Party"-ish
 *       weightUnits, measurementUnit,  <- e.g. "LBS" / "IN"
 *       details: [{ length, width, height, weight, class, units }],
 *       accessorials: {
 *         codes: [ ... ],              <- see ACCESSORIAL_CODES below for the full valid list
 *         excessiveLengthTotalInches?, fullValueCoverageMonetaryValue?
 *       },
 *       internationalData: { declaredValue }  <- optional
 *     }
 *   accountCode is REQUIRED on origin — confirmed via a real 400 error
 *   ("An Account Code must be Provided"), contradicting Saia's own product
 *   description which claims it's optional/auto-selected. Set
 *   SAIA_ACCOUNT_CODE in .env to your company's Saia account number and
 *   it's applied automatically to every quote.
 *
 * CONFIRMED for Rate Quote (from a real successful quote, 2026-08-12):
 *   - The full success response shape (see getRateQuote's return mapping).
 *   - "Shipper" is a valid value for `payer`.
 *   - An accountCode is required on origin (see SAIA_ACCOUNT_CODE above).
 *
 * STILL UNCONFIRMED for Rate Quote:
 *   1. Whether this dev-api.saia.com host is also the production host, or
 *      whether prod uses a different domain.
 *   2. Other valid `payer` values ("Third Party"/"Consignee"/etc.) if you
 *      ever need non-shipper-paid quotes.
 *
 * TRACKING is entirely unconfirmed — we only know the API exists in Saia's
 * catalog ("Tracking REST Customer API"), not its schema. getTrackingStatus()
 * below is a placeholder shaped like Rate Quote's pattern until you pull its
 * real OpenAPI spec / "Try it" example the same way as Rate Quote.
 *
 * Until all of that is filled in, MOCK_MODE keeps everything working
 * end-to-end with fake data so the rest of the app can be built and tested.
 */

const MOCK_MODE = String(process.env.MOCK_MODE || "true").toLowerCase() !== "false";

// The full, confirmed list of valid accessorial codes for Rate Quote.
const ACCESSORIAL_CODES = [
  "SingleShipment", "ArrivalNotice/Appointment", "Marking/Tagging",
  "LimitedAccessLocationPU", "LimitedAccessLocation", "LiftgateServicePU",
  "LiftgateService", "InBond", "InsidePickup", "InsideDelivery",
  "ExcessiveLength", "GroceryWarehouse", "Hazardous", "ProtectionFromFreezing",
  "ResidentialPickup", "ResidentialDelivery", "RoomOfChoice", "WhiteGlove",
  "Sorting/Segregating", "Sorting/SegregatingPickup", "BorderCrossing",
  "TradeShowPickup", "TradeShowDelivery", "MexicoBorderDrayage",
  "XtremeAssurance", "FullValueCoverage",
];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    "RQ-Key": process.env.SAIA_SUBSCRIPTION_KEY || "",
  };
}

function randomId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/* ---------------------------------------------------------
   RATE QUOTE
--------------------------------------------------------- */

function buildRateQuotePayload(input) {
  const payload = {
    userID: requireEnv("SAIA_USER_ID"),
    password: requireEnv("SAIA_PASSWORD"),
    payer: input.payer || process.env.SAIA_DEFAULT_PAYER || "Shipper",
    origin: {
      city: input.originCity || "",
      state: input.originState || "",
      zipcode: input.originZip || "",
    },
    destination: {
      city: input.destCity || "",
      state: input.destState || "",
      zipcode: input.destZip || "",
    },
    weightUnits: input.weightUnits || process.env.SAIA_WEIGHT_UNITS || "LBS",
    measurementUnit: input.measurementUnit || process.env.SAIA_MEASUREMENT_UNIT || "IN",
    details: input.details && input.details.length
      ? input.details
      : [
          {
            length: input.length || 0,
            width: input.width || 0,
            height: input.height || 0,
            weight: Number(input.weight) || 0,
            class: Number(input.freightClass) || 0,
            units: Number(input.pieces) || 1,
          },
        ],
    accessorials: {
      codes: input.accessorialCodes || (input.liftgate ? ["LiftgateService"] : []),
    },
  };

  if (input.pickupDate) payload.pickUpDate = input.pickupDate;
  // CONFIRMED via a real 400 response: an accountCode is required, despite
  // Saia's own product description claiming it's optional/auto-selected.
  // Falls back to SAIA_ACCOUNT_CODE (your company's Saia account number)
  // so the front end doesn't need to supply one on every request.
  const originAccountCode = input.originAccountCode || process.env.SAIA_ACCOUNT_CODE;
  if (originAccountCode) payload.origin.accountCode = originAccountCode;
  if (input.destAccountCode) payload.destination.accountCode = input.destAccountCode;
  if (input.thirdPartyAccountCode) {
    payload.thirdPartyDetails = { accountCode: input.thirdPartyAccountCode };
  }
  return payload;
}

async function getRateQuote(input) {
  if (MOCK_MODE) {
    return {
      mock: true,
      quoteId: randomId("QTE"),
      carrier: "Saia",
      totalCharge: Math.round((Number(input.weight || 500) * 0.42 + 85) * 100) / 100,
      currency: "USD",
      transitDays: 3,
      originZip: input.originZip,
      destZip: input.destZip,
      validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  const baseUrl = process.env.SAIA_RATE_QUOTE_BASE_URL || "https://dev-api.saia.com/rate-quote";
  const path = process.env.SAIA_RATE_QUOTE_PATH || "/webservice/ratequote/customer-api";
  const payload = buildRateQuotePayload(input);

  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // CONFIRMED real failure shape: { status: "FAIL", fault, errors: [...] }
    const firstError = data?.errors?.[0];
    const detail = firstError ? Object.values(firstError)[0]?.message : null;
    throw new Error(`Saia rate quote failed: ${detail || JSON.stringify(data)}`);
  }

  // CONFIRMED real success shape (from a live quote, 2026-08-12). Normalized
  // into the field names the front end expects, with the full raw response
  // kept alongside for anything not surfaced yet.
  return {
    mock: false,
    totalCharge: data.rateDetails?.totalInvoice ?? null,
    currency: "USD",
    transitDays: data.standardServiceDays ?? null,
    validUntil: data.expirationDate ?? null,
    quoteNumber: data.quoteNumber ?? null,
    estimatedDeliveryDate: data.estimatedDeliveryDate ?? null,
    tariff: data.rateDetails?.tariff ?? null,
    raw: data,
  };
}

/* ---------------------------------------------------------
   TRACKING
   Confirmed from the real OpenAPI spec for "Tracking REST Customer API":
     Server: https://dev-api.saia.com/customer-api  (dev/test environment)
     Path:   GET /webservice/track/pro-numbers/{number}
             (there are sibling operations for tracking by BOL number,
             partner PRO number, PO number, shipper number, or pickup
             number instead — those need a zip code too; PRO number alone
             is the best match for what we store, so that's what we use)
     Headers:
       Tracking-Key: <subscription key from the developer portal, likely a
                      separate key from Rate Quote's RQ-Key since it's a
                      different product to subscribe to — unconfirmed
                      whether they can be the same key>
       Authorization: Basic <base64(username:password)>
         The spec explicitly says this must be a "Saia Secure account"
         (saia.com's own customer login) and is NOT the Developer Portal
         login. This is presumably the same account referenced by
         SAIA_USER_ID/SAIA_PASSWORD used in Rate Quote's request body —
         reused here for Basic Auth. Confirm that assumption once you can
         test; if Rate Quote and Tracking turn out to need different
         accounts, split them into separate env vars.
   There's no request body — it's a plain GET with the PRO number in the URL.

   STILL UNCONFIRMED: the response shape. The spec doesn't document one.
--------------------------------------------------------- */

function trackingAuthHeaders() {
  const user = requireEnv("SAIA_USER_ID");
  const pass = requireEnv("SAIA_PASSWORD");
  const basic = Buffer.from(`${user}:${pass}`).toString("base64");
  return {
    "Tracking-Key": process.env.SAIA_TRACKING_KEY || process.env.SAIA_SUBSCRIPTION_KEY || "",
    Authorization: `Basic ${basic}`,
  };
}

async function getTrackingStatus(input) {
  if (MOCK_MODE) {
    const statuses = ["Picked Up", "In Transit", "Out for Delivery", "Delivered"];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    return {
      mock: true,
      trackingNumber: input.trackingNumber,
      status,
      lastLocation: status === "Delivered" ? null : "Memphis, TN",
      lastUpdated: new Date().toISOString(),
      deliveredDate: status === "Delivered" ? new Date().toISOString() : null,
    };
  }

  const baseUrl = process.env.SAIA_TRACKING_BASE_URL || "https://dev-api.saia.com/customer-api";
  const path = `/webservice/track/pro-numbers/${encodeURIComponent(input.trackingNumber)}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: trackingAuthHeaders(),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Saia tracking HTTP error (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = { getRateQuote, getTrackingStatus, ACCESSORIAL_CODES, MOCK_MODE };
