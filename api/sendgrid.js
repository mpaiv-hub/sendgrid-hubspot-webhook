import fetch from "node-fetch";
import { EventWebhook, EventWebhookHeader } from "@sendgrid/eventwebhook";

// IMPORTANT: Vercel must give us the raw request body (not parsed JSON)
export const config = {
  api: {
    bodyParser: false,
  },
};

// Reads the raw request body into a Buffer
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Updates an existing HubSpot Email engagement
async function hubspotPatchEmail(emailId, props) {
  const token = process.env.HUBSPOT_ACCESS_TOKEN;

  const res = await fetch(`https://api.hubapi.com/crm/v3/objects/emails/${emailId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties: props }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HubSpot error ${res.status}: ${text}`);
  }

  return res.json();
}

// Convert SendGrid event names into HubSpot email statuses
function mapStatus(sendgridEvent) {
  if (sendgridEvent === "delivered") return "SENT";
  if (sendgridEvent === "bounce") return "BOUNCED";
  if (sendgridEvent === "dropped") return "FAILED";
  return null; // ignore opens/clicks for now
}

export default async function handler(req, res) {
  try {
    // 1) Read raw body
    const rawBody = await getRawBody(req);

    // 2) Verify SendGrid signature
    const signature = req.headers[EventWebhookHeader.SIGNATURE().toLowerCase()];
    const timestamp = req.headers[EventWebhookHeader.TIMESTAMP().toLowerCase()];

    const ew = new EventWebhook();
    const publicKey = ew.convertPublicKeyToECDSA(process.env.SENDGRID_WEBHOOK_PUBLIC_KEY);

    const valid = ew.verifySignature(publicKey, rawBody, signature, timestamp);
    if (!valid) return res.status(401).send("Invalid signature");

    // 3) Parse events (SendGrid sends an array)
    const events = JSON.parse(rawBody.toString("utf8"));
    if (!Array.isArray(events)) return res.status(400).send("Expected an array of events");

    // 4) Loop through events and update HubSpot email engagement if we have its ID
    for (const e of events) {
      const hsEmailId = e?.custom_args?.hs_email_engagement_id;
      if (!hsEmailId) continue;

      const status = mapStatus(e.event);
      if (!status) continue;

      await hubspotPatchEmail(hsEmailId, { hs_email_status: status });
    }

    // 5) Done
    return res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error");
  }
}
