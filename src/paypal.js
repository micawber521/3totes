// PayPal REST, server side only. The secret never reaches the browser.
//   PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_WEBHOOK_ID  (Worker secrets)
//   PAYPAL_ENV  "live" for production; anything else = sandbox
//
// Money model (verified against sandbox 2026-11-23): one subscription per booking, built from the
// current admin settings at booking time:
//   setup fee  = deposit + first rental period + delivery fee, charged at approval (fails → subscription cancelled)
//   moving     = REGULAR weekly at moving_weekly, first renewal 14 days after delivery
//   storage    = REGULAR monthly at storage_monthly, first renewal 1 month after delivery
// (Policy 2026-11-23: pay the first period at booking; the rental clock still starts at delivery.)

export const paypalReady = (env) => Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_SECRET);
const base = (env) => (String(env.PAYPAL_ENV || "").trim() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com");
const usd = (cents) => ({ value: (cents / 100).toFixed(2), currency_code: "USD" });

let tokenCache = { key: "", token: "", until: 0 };

async function token(env) {
  const key = env.PAYPAL_CLIENT_ID.trim();
  if (tokenCache.key === key && Date.now() < tokenCache.until) return tokenCache.token;
  const r = await fetch(`${base(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${key}:${env.PAYPAL_SECRET.trim()}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`paypal auth ${r.status}`);
  const j = await r.json();
  tokenCache = { key, token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 300) - 120) * 1000 };
  return j.access_token;
}

export async function paypal(env, method, path, body) {
  const r = await fetch(`${base(env)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token(env)}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) console.error(`paypal ${method} ${path} → ${r.status}`, data && (data.name || data.error), data && data.debug_id);
  return { ok: r.ok, status: r.status, data };
}

// One PayPal catalog product for all rentals; its id is cached in settings.
async function productId(env, db) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'paypal_product_id'").first();
  const envTag = String(env.PAYPAL_ENV || "sandbox").trim() || "sandbox";
  if (row && row.value.startsWith(envTag + ":")) return row.value.slice(envTag.length + 1);
  const r = await paypal(env, "POST", "/v1/catalogs/products", { name: "Tote rental kit", type: "SERVICE", description: "Totes Totes Totes moving/storage tote rental" });
  if (!r.ok) throw new Error("paypal product create failed");
  await db.prepare("INSERT INTO settings (key, value) VALUES ('paypal_product_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(`${envTag}:${r.data.id}`).run();
  return r.data.id;
}

// Creates the per-booking plan + subscription. Returns { planId, subscriptionId }.
export function firstRenewalDate(plan, deliveryDate) {
  const d = new Date(deliveryDate + "T12:00:00Z");
  if (plan === "moving") d.setUTCDate(d.getUTCDate() + 14); else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export async function createRentalSubscription(env, db, { bookingId, plan, recurringCents, setupCents, deliveryDate, origin }) {
  const cycles = [{
    tenure_type: "REGULAR", sequence: 1, total_cycles: 0,
    frequency: plan === "moving" ? { interval_unit: "WEEK", interval_count: 1 } : { interval_unit: "MONTH", interval_count: 1 },
    pricing_scheme: { fixed_price: usd(recurringCents) },
  }];
  const p = await paypal(env, "POST", "/v1/billing/plans", {
    product_id: await productId(env, db),
    name: `Booking #${bookingId} (${plan})`,
    status: "ACTIVE",
    billing_cycles: cycles,
    payment_preferences: { auto_bill_outstanding: true, setup_fee: usd(setupCents), setup_fee_failure_action: "CANCEL", payment_failure_threshold: 2 },
  });
  if (!p.ok) throw new Error("paypal plan create failed");

  // First renewal, morning (~8am Central); always in the future because delivery is at least tomorrow.
  const start = `${firstRenewalDate(plan, deliveryDate)}T14:00:00Z`;
  const s = await paypal(env, "POST", "/v1/billing/subscriptions", {
    plan_id: p.data.id,
    start_time: start,
    custom_id: String(bookingId),
    application_context: {
      brand_name: "Totes Totes Totes", shipping_preference: "NO_SHIPPING", user_action: "SUBSCRIBE_NOW",
      return_url: `${origin}/book?done=1`, cancel_url: `${origin}/book`,
    },
  });
  if (!s.ok) throw new Error("paypal subscription create failed");
  return { planId: p.data.id, subscriptionId: s.data.id };
}

export const getSubscription = (env, id) => paypal(env, "GET", `/v1/billing/subscriptions/${encodeURIComponent(id)}`);
export const cancelSubscription = (env, id, reason) =>
  paypal(env, "POST", `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, { reason: String(reason).slice(0, 120) });
export const refundSale = (env, saleId, cents) =>
  paypal(env, "POST", `/v1/payments/sale/${encodeURIComponent(saleId)}/refund`, { amount: { total: (cents / 100).toFixed(2), currency: "USD" } });

// Webhook authenticity: ask PayPal to verify the signature headers against our webhook id.
export async function verifyWebhook(env, request, event) {
  if (!env.PAYPAL_WEBHOOK_ID) return false;
  const h = (k) => request.headers.get(k) || "";
  const r = await paypal(env, "POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"), cert_url: h("paypal-cert-url"), transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"), transmission_time: h("paypal-transmission-time"),
    webhook_id: env.PAYPAL_WEBHOOK_ID.trim(), webhook_event: event,
  });
  return r.ok && r.data.verification_status === "SUCCESS";
}
