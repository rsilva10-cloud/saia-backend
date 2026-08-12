# Saia Backend (Rate Quotes + Tracking)

A minimal Node/Express backend that sits between your PO tool and Saia LTL
Freight's API. It exists because a browser-based app can't safely hold a
carrier API key or reliably make server-to-server API calls directly — this
backend holds the credentials and exposes two endpoints:

- `POST /api/saia/quote` — get a rate quote
- `POST /api/saia/track` — look up live status for a tracking/PRO number

## Scope: no pickup booking

Saia's self-service developer API only covers Rate Quote, Tracking, Bill of
Lading, and Imaging — there's no dispatch/pickup-booking endpoint available.
So pickups are booked manually (Saia's own site, phone, or email), and the
resulting PRO/confirmation number is entered by hand into the PO tool. This
backend then uses that number to show live tracking status inline.

## Status: mock mode by default

`saiaClient.js` builds the confirmed Rate Quote schema (see below) and a
placeholder Tracking schema, but several pieces are still missing until you
sign up and pull real examples from the portal:
1. The exact runtime URL for Rate Quote (`SAIA_RATE_QUOTE_BASE_URL`).
2. The exact runtime URL for Tracking (`SAIA_TRACKING_BASE_URL`) — these
   are separate APIs and may not share a base URL.
3. What a real Rate Quote success/error response looks like.
4. The full Tracking request/response schema — only the API's existence is
   confirmed so far, not its shape.

Until those are filled in, this backend runs in **mock mode**: every call
returns a realistic, clearly-labeled fake response so you can build and test
the rest of the app today.

## What we've confirmed about Saia's real API

Saia's developer portal (there appear to be at least two environments,
`saiapilotapi.developer.azure-api.net` and
`saiaprodapi.developer.azure-api.net`) lists these APIs:

| API | Type | Purpose |
|---|---|---|
| REST Rate Quote Customer API | REST | Rate quotes |
| Test RateQuote - V1 | SOAP | Legacy version of the same |
| Tracking REST Customer API | REST | Shipment tracking |
| NMFTA Electronic Bill Of Lading Service | REST | e-BOL generation |
| Customer Imaging API / Test Get Images - V1 | REST | Shipment images/documents |
| Carrierlink webservice uat | REST | For final-mile carriers to push status *to* Saia — not for us |

This portal login is separate from your regular saia.com shipping/customer
account — sign up for it independently.

The **Rate Quote** request schema, pulled directly from that API's "Try it"
console, is confirmed to be:

```json
{
  "userID": "string",
  "password": "string",
  "payer": "string",
  "origin": { "city": "string", "state": "string", "zipcode": "string" },
  "destination": { "city": "string", "state": "string", "zipcode": "string" },
  "weightUnits": "string",
  "measurementUnit": "string",
  "details": [{ "length": 0, "width": 0, "height": 0, "weight": 0, "class": 0, "units": 0 }],
  "accessorials": { "codes": [] }
}
```

Your real Saia account login (`userID`/`password`) goes directly in this
body — not just a subscription key in a header. That's a more sensitive
credential than the portal subscription key and must live only in this
backend's `.env` file.

**Tracking's schema is not yet confirmed** — `getTrackingStatus()` currently
guesses a `{ userID, password, trackingNumber }` shape based on the Rate
Quote pattern. Open the "Tracking REST Customer API" page's "Try it"
console the same way you did for Rate Quote, copy its example, and paste it
here so I can correct `buildTrackingPayload()`.

## Getting the rest of what's needed

1. Sign up at the developer portal (whichever environment you're targeting
   — pilot for testing, prod for live).
2. Under **Products**, subscribe to Rate Quote and Tracking to get a
   subscription key.
3. Open each API's page and use its **"Try it"** console:
   - Confirm the exact request URL for each.
   - For Rate Quote, submit a sample request to see a real response.
   - For Tracking, copy the full request/response schema — paste it here.
4. Fill in `.env` with `SAIA_USER_ID`, `SAIA_PASSWORD`,
   `SAIA_SUBSCRIPTION_KEY`, `SAIA_RATE_QUOTE_BASE_URL`, and
   `SAIA_TRACKING_BASE_URL`.
5. Set `MOCK_MODE=false` once you're ready to test against Saia for real.

## Local setup

```bash
cd saia-backend
cp .env.example .env
npm install
npm start
```

Server runs on `http://localhost:3001` by default. Test it:

```bash
curl http://localhost:3001/api/health
# {"ok":true,"mockMode":true}

curl -X POST http://localhost:3001/api/saia/quote \
  -H "Content-Type: application/json" \
  -d '{
    "originCity": "Reno", "originState": "NV", "originZip": "89521",
    "destCity": "Greenville", "destState": "NC", "destZip": "27834",
    "weight": 1200, "freightClass": "70", "pieces": 4
  }'

curl -X POST http://localhost:3001/api/saia/track \
  -H "Content-Type: application/json" \
  -d '{"trackingNumber": "123456789"}'
```

## Deploying so the PO tool can reach it

Easiest option: **Render** (free tier, no credit card for a basic web service).

1. Push this `saia-backend` folder to a GitHub repo.
2. In Render, click "New Web Service," connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add the environment variables from `.env.example` in Render's dashboard.
5. Once deployed, Render gives you a URL like `https://your-app.onrender.com`.
6. Paste that URL into the PO tool's Settings panel (Saia Backend URL field).

Any other Node host (Railway, Fly.io, a plain VPS) works the same way — install
dependencies, set env vars, run `npm start`.

## A note on the front-end connection

The PO tool artifact runs inside Claude's chat interface, which may restrict
outbound network calls to arbitrary domains. If quote/tracking calls can't
reach your deployed backend from inside the chat, the fix is to deploy the
whole PO tool (the React app) to your own hosting (e.g. Vercel, Netlify) so
it isn't limited by the chat sandbox's network policy. The backend here
works the same either way.
