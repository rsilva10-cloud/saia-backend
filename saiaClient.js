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
 * TRACKING uses Saia's older SOAP "Shipment" API (GetByProNumber operation)
 * — fully documented by Saia, unlike the REST "Tracking REST Customer API"
 * we tried first, which kept rejecting every subscription key tested
 * against it. See the detailed comment above getTrackingStatus() below.
 *
 * Until MOCK_MODE is off, everything works end-to-end with fake data so
 * the rest of the app can be built and tested without live credentials.
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
       Tracking-Key: <subscription key>
         CONFIRMED (2026-08-12, real 401 response): this MUST be a separate
         key from Rate Quote's RQ-Key — reusing the Rate Quote key returns
         "Access denied due to invalid subscription key." Subscribe to the
         Tracking product specifically in the portal and set
         SAIA_TRACKING_KEY to that key.
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

/* ---------------------------------------------------------
   TRACKING
   SWITCHED (2026-08-12) from the broken/undocumented "Tracking REST
   Customer API" to Saia's older but fully-documented SOAP "Shipment"
   API — specifically its GetByProNumber operation. The REST one kept
   rejecting every subscription key tried against it; this SOAP one has a
   complete, confirmed request/response schema and uses a subscription
   ("Shipment Tracking Key") that was already confirmed Active.

   CONFIRMED from Saia's own docs for this operation:
     URL:     POST https://api.saia.com/soap/shipment/?soapAction=http://www.SaiaSecure.com/WebService/Shipment/GetByProNumber
              (note: api.saia.com, NOT dev-api.saia.com — a different host
              than Rate Quote uses)
     Headers:
       Content-Type: application/soap+xml;action="http://www.SaiaSecure.com/WebService/Shipment/GetByProNumber"
       Ocp-Apim-Subscription-Key: <your Shipment Tracking Key>
       Api-Version: v2
     Body (XML): UserID, Password, TestMode (Y/N), ProNumber
     Response (XML): Code/Element/Fault/Message (error handling, present on
       every response — Code non-empty means something failed), plus
       ProNumber, CurrentStatus (one of a fixed list of status strings —
       see CURRENT_STATUS_VALUES below), BLNumber, PONumber, ShipperNumber,
       ReferenceNumber, MasterProNumber, DriverNumber, TrailerNumber,
       OnTime, LatePickup, Accessorials, Hazardous, Appointment.
     TestMode: Y = sandbox/generic test data, N = live data. Controlled
       here by SAIA_TRACKING_LIVE_DATA (defaults to test/"Y" for safety).

   Parsed with simple regex tag extraction rather than a full XML parser —
   the response is flat (no repeated/nested elements to disambiguate),
   and it avoids pulling in an XML parsing dependency for what's ultimately
   a handful of known tag names from a trusted, non-user-controlled source.
--------------------------------------------------------- */

const CURRENT_STATUS_VALUES = [
  "P/U manifest", "Arrived at origin terminal", "Loaded on trailer", "Linehaul",
  "Break", "Dock manifest", "Arrived at destination terminal",
  "Arrived at exchange terminal", "Arrived at Breakbulk Terminal",
  "Scheduled for delivery", "Tendered to partner", "En route via partner",
  "Trailer at customer location", "Customer loading trailer",
  "Departed from Terminal", "Out for delivery", "Delivered",
  "Delivered to partner", "Cleared", "Rev. only", "Void", "Delete",
];

function extractXmlTag(xml, tag) {
  // Tolerates an optional namespace prefix (e.g. <a:Code>...</a:Code>),
  // which SOAP responses commonly use but which a plain <Code> match would miss.
  const match = xml.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`, "i"));
  return match ? match[1] : null;
}

function trackingLiveMode() {
  return String(process.env.SAIA_TRACKING_LIVE_DATA || "false").toLowerCase() === "true" ? "N" : "Y";
}

function buildTrackingSoapBody(input) {
  return `<?xml version="1.0" encoding="utf-8"?>
<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope">
  <Body>
    <GetByProNumber xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://www.SaiaSecure.com/WebService/Shipment">
      <request>
        <UserID>${requireEnv("SAIA_USER_ID")}</UserID>
        <Password>${requireEnv("SAIA_PASSWORD")}</Password>
        <TestMode>${trackingLiveMode()}</TestMode>
        <ProNumber>${input.trackingNumber}</ProNumber>
      </request>
    </GetByProNumber>
  </Body>
</Envelope>`;
}

async function getTrackingStatus(input) {
  if (MOCK_MODE) {
    const statuses = ["Arrived at origin terminal", "Linehaul", "Out for delivery", "Delivered"];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    return {
      mock: true,
      trackingNumber: input.trackingNumber,
      status,
      lastLocation: "Memphis, TN",
      lastUpdated: new Date().toISOString(),
      deliveredDate: status === "Delivered" ? new Date().toISOString() : null,
      consigneeName: "Sample Consignee",
      consigneeCity: "Greenville",
      consigneeState: "NC",
      history: [{ activity: status, city: "Memphis", state: "TN", dateTime: new Date().toISOString(), statusCode: null }],
      totalBilled: 1934.88,
    };
  }

  const soapAction = "http://www.SaiaSecure.com/WebService/Shipment/GetByProNumber";
  const url = `https://api.saia.com/soap/shipment/?soapAction=${soapAction}`;
  const body = buildTrackingSoapBody(input);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": `application/soap+xml;action="${soapAction}"`,
      "Ocp-Apim-Subscription-Key": process.env.SAIA_TRACKING_KEY || "",
      "Api-Version": "v2",
    },
    body,
  });

  const xml = await res.text();
  if (!res.ok) {
    throw new Error(`Saia tracking HTTP error (${res.status}): ${xml}`);
  }

  // CONFIRMED (2026-08-12, real delivered shipment) real success responses
  // contain a <Shipper> block and have NO top-level error wrapper — they
  // look nothing like the simple <Response><Code>/<Element>/<Fault>/
  // <Message>/<CurrentStatus> shape Saia's own docs describe. That
  // documented shape may only appear on genuine errors, or may be stale
  // docs entirely. Real successful responses instead nest Shipper,
  // Consignee, ThirdParty, MailTo, Details (rate/billing line items), and
  // History (an array of scan events — no single "CurrentStatus" field).
  //
  // IMPORTANT GOTCHA we hit: <Details><DetailItem> line items have their
  // own <Code> element (freight class / accessorial codes, e.g. "55",
  // "FS", "SS") that has NOTHING to do with errors. A naive "does <Code>
  // appear anywhere in the document" check false-triggers on this. Using
  // <Shipper> presence as the success signal avoids that trap.
  const isSuccess = /<Shipper>/i.test(xml);

  if (!isSuccess) {
    const code = extractXmlTag(xml, "Code");
    const message = extractXmlTag(xml, "Message");
    const fault = extractXmlTag(xml, "Fault");
    throw new Error(
      `Saia tracking error (${code}, fault=${fault}): ${message || "no message"} | RAW: ${xml.slice(0, 2000)}`
    );
  }

  function extractAllBlocks(source, tag) {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi");
    const blocks = [];
    let m;
    while ((m = re.exec(source)) !== null) blocks.push(m[1]);
    return blocks;
  }
  function extractBlock(source, tag) {
    const m = source.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i"));
    return m ? m[1] : "";
  }

  // History is a repeating array of scan events. Not confirmed whether
  // it's newest-first or oldest-first — treating the first entry as most
  // recent based on this test (it was "Delivered", the logical last event
  // for a completed shipment). Worth double-checking against a shipment
  // that's still in transit, where the ordering will be more obvious.
  const history = extractAllBlocks(xml, "HistoryItem").map((block) => ({
    activity: extractXmlTag(block, "Activity"),
    city: extractXmlTag(block, "City"),
    state: extractXmlTag(block, "State"),
    dateTime: extractXmlTag(block, "ActivityDateTime"),
    statusCode: extractXmlTag(block, "StatusCode"),
  }));
  const latest = history[0] || {};
  const deliveredEntry = history.find((h) => (h.activity || "").toLowerCase() === "delivered");

  const consigneeBlock = extractBlock(xml, "Consignee");
  const details = extractAllBlocks(xml, "DetailItem").map((block) => ({
    description: extractXmlTag(block, "Description"),
    weight: extractXmlTag(block, "Weight"),
    amount: extractXmlTag(block, "Amount"),
  }));
  const totalAmount = details.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

  return {
    mock: false,
    trackingNumber: input.trackingNumber,
    status: latest.activity || null,
    lastLocation: latest.city && latest.state ? `${latest.city}, ${latest.state}` : null,
    lastUpdated: latest.dateTime || null,
    deliveredDate: deliveredEntry ? deliveredEntry.dateTime : null,
    consigneeName: extractXmlTag(consigneeBlock, "Name"),
    consigneeCity: extractXmlTag(consigneeBlock, "City"),
    consigneeState: extractXmlTag(consigneeBlock, "State"),
    history,
    totalBilled: Math.round(totalAmount * 100) / 100,
    raw: xml,
  };
}

module.exports = { getRateQuote, getTrackingStatus, ACCESSORIAL_CODES, CURRENT_STATUS_VALUES, MOCK_MODE };
