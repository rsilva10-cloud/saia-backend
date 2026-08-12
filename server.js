require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { getRateQuote, getTrackingStatus, MOCK_MODE } = require("./saiaClient");

const app = express();
app.use(express.json());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
app.use(
  cors({
    origin: allowedOrigins.includes("*") ? true : allowedOrigins,
  })
);

app.get("/api/health", (req, res) => {
  res.json({ ok: true, mockMode: MOCK_MODE });
});

app.post("/api/saia/quote", async (req, res) => {
  try {
    const { originZip, destZip, weight } = req.body || {};
    if (!originZip || !destZip || !weight) {
      return res.status(400).json({ error: "originZip, destZip, and weight are required" });
    }
    const quote = await getRateQuote(req.body);
    res.json(quote);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Rate quote failed" });
  }
});

app.post("/api/saia/track", async (req, res) => {
  try {
    const { trackingNumber } = req.body || {};
    if (!trackingNumber) {
      return res.status(400).json({ error: "trackingNumber is required" });
    }
    const status = await getTrackingStatus({ trackingNumber });
    res.json(status);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Tracking lookup failed" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`Saia backend listening on :${port} (mock mode: ${MOCK_MODE})`);
});
