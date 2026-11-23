// Customer online booking (/book) + PayPal webhook.
// Hidden behind the `online_booking` setting; while off, /book?preview=<booking_preview_key> still works
// so Christian can test end to end (sandbox).
import { ensureSchema, getSettings, kitBlocks, freeKit, kitConflict, newToken } from "./db.js";
import { paypalReady, createRentalSubscription, getSubscription, verifyWebhook } from "./paypal.js";
import { trySend } from "./mail.js";

const TZ = "America/Chicago";
const HOLD_MINUTES = 30;
const WINDOW_DAYS = { moving: 14, storage: 30 }; // a kit must be free this long from the delivery day
const LIMITS = { name: 100, email: 200, phone: 30, address: 200, notes: 1000 };

const json = (status, obj) => Response.json(obj, { status, headers: { "cache-control": "no-store" } });
const money = (c) => "$" + (Number(c || 0) / 100).toFixed(2);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !Number.isNaN(Date.parse(s + "T12:00:00Z"));
const niceDate = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const emailOk = (e) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e);
const ownerEmail = (env) => String(env.CONTACT_EMAIL || "").trim();

function access(s, url) {
  const preview = (url.searchParams.get("preview") || "").trim();
  return s.online_booking === "on" || (preview && preview === s.booking_preview_key);
}

function rates(s, plan) {
  return plan === "moving"
    ? { first: Number(s.moving_first_cents), recurring: Number(s.moving_weekly_cents) }
    : { first: Number(s.storage_monthly_cents), recurring: Number(s.storage_monthly_cents) };
}

async function availableDates(db, s, plan) {
  const lead = Math.max(1, Number(s.lead_days) || 1); // drop-off is first thing in the morning → never same day
  const first = addDays(today(), lead), last = addDays(today(), 75);
  const state = await kitBlocks(db, s.buffer_days);
  const out = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (freeKit(state, d, addDays(d, WINDOW_DAYS[plan] - 1))) out.push(d);
  }
  return { first, last, dates: out };
}

// ---------- router ----------

export async function handleBook(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, "");
  if (p === "/api/paypal/webhook") return webhook(request, env);
  if (!env.DB) return p === "/book" ? comingSoon() : json(503, { ok: false, msg: "Booking is not available yet." });
  await ensureSchema(env.DB);
  const s = await getSettings(env.DB);

  if (p === "/book" && request.method === "GET") return access(s, url) ? bookPage(env, s, url) : comingSoon();
  const my = p.match(/^\/my\/([0-9a-f]{48})$/);
  if (my && request.method === "GET") return myPage(env, s, my[1], url);
  const myApi = p.match(/^\/api\/my\/([0-9a-f]{48})\/(pickup|estimate|cancel_pickup)$/);
  if (myApi && request.method === "POST") {
    if (!["https://3totes.com", "https://www.3totes.com", url.origin].includes(request.headers.get("Origin") || "")) return json(403, { ok: false, msg: "Forbidden" });
    return myAction(request, env, s, myApi[1], myApi[2]);
  }
  if (!p.startsWith("/api/book/")) return null;
  if (request.method === "POST" && !["https://3totes.com", "https://www.3totes.com", url.origin].includes(request.headers.get("Origin") || ""))
    return json(403, { ok: false, msg: "Forbidden" });
  if (p === "/api/book/waitlist" && request.method === "POST") return waitlist(env.DB, request);
  if (!access(s, url)) return json(403, { ok: false, msg: "Online booking is not open yet." });

  if (p === "/api/book/zip" && request.method === "GET") return zipCheck(env.DB, url);
  if (p === "/api/book/dates" && request.method === "GET") {
    const plan = url.searchParams.get("plan") === "storage" ? "storage" : "moving";
    return json(200, { ok: true, plan, ...(await availableDates(env.DB, s, plan)) });
  }
  if (p === "/api/book/start" && request.method === "POST") return start(request, env, s, url);
  if (p === "/api/book/approve" && request.method === "POST") return approve(request, env);
  return json(404, { ok: false, msg: "Not found" });
}

async function zipCheck(db, url) {
  const zip = (url.searchParams.get("zip") || "").trim();
  if (!/^\d{5}$/.test(zip)) return json(400, { ok: false, msg: "Enter a 5-digit zip code." });
  const z = await db.prepare("SELECT zone, delivery_fee_cents FROM zones WHERE zip = ?").bind(zip).first();
  if (!z) return json(200, { ok: true, served: false, zip });
  return json(200, { ok: true, served: true, zip, zone: z.zone, fee_cents: z.delivery_fee_cents });
}

async function waitlist(db, request) {
  const b = await request.json().catch(() => ({}));
  const email = String(b.email || "").trim(), zip = String(b.zip || "").trim();
  if (!emailOk(email) || email.length > LIMITS.email) return json(400, { ok: false, msg: "Please enter a valid email address." });
  await db.prepare("INSERT INTO waitlist (email, zip) VALUES (?, ?)").bind(email, /^\d{5}$/.test(zip) ? zip : null).run();
  return json(200, { ok: true, msg: "Thanks! We'll let you know when we deliver to your area." });
}

// Validate, hold a kit, create the PayPal subscription. Returns { bookingId, subscriptionId }.
async function start(request, env, s, url) {
  if (!paypalReady(env)) return json(503, { ok: false, msg: "Payments are not set up yet." });
  const db = env.DB;
  const b = await request.json().catch(() => null);
  if (!b) return json(400, { ok: false, msg: "Bad request" });
  const v = {};
  for (const k of ["zip", "plan", "date", "est_return", "name", "phone", "email", "address", "notes", "signed_name"]) v[k] = String(b[k] ?? "").trim();

  if (!/^\d{5}$/.test(v.zip)) return json(400, { ok: false, msg: "Enter a 5-digit zip code." });
  const zone = await db.prepare("SELECT zone, delivery_fee_cents FROM zones WHERE zip = ?").bind(v.zip).first();
  if (!zone) return json(400, { ok: false, msg: "Sorry, we don't deliver to that zip code yet." });
  if (!["moving", "storage"].includes(v.plan)) return json(400, { ok: false, msg: "Pick a plan." });
  if (!isDate(v.date)) return json(400, { ok: false, msg: "Pick a delivery day." });
  if (v.est_return && (!isDate(v.est_return) || v.est_return <= v.date || v.est_return > addDays(v.date, 365)))
    return json(400, { ok: false, msg: "Your estimated pickup date should be after the delivery day." });
  if (!v.name || !v.phone || !v.email || !v.address) return json(400, { ok: false, msg: "Please fill in your name, phone, email and address." });
  for (const k of Object.keys(LIMITS)) if (v[k].length > LIMITS[k]) return json(400, { ok: false, msg: `That ${k} is too long.` });
  if (!emailOk(v.email)) return json(400, { ok: false, msg: "Please enter a valid email address." });
  if (b.agree !== true || v.signed_name.length < 2) return json(400, { ok: false, msg: "Please read the rental agreement, check the box and type your name to sign." });
  if (!s.agreement_text && s.online_booking === "on") return json(503, { ok: false, msg: "Booking is temporarily unavailable." });

  const { dates } = await availableDates(db, s, v.plan);
  if (!dates.includes(v.date)) return json(409, { ok: false, msg: "Sorry, that day was just taken. Please pick another day.", refresh: true });

  const r = rates(s, v.plan);
  const deposit = Number(s.deposit_cents) || 0;
  const windowEnd = addDays(v.date, WINDOW_DAYS[v.plan] - 1);
  const state = await kitBlocks(db, s.buffer_days);
  const kitId = freeKit(state, v.date, windowEnd);
  if (!kitId) return json(409, { ok: false, msg: "Sorry, that day was just taken. Please pick another day.", refresh: true });

  let customer = await db.prepare("SELECT id FROM customers WHERE lower(email) = lower(?)").bind(v.email).first();
  if (customer) await db.prepare("UPDATE customers SET name = ?, phone = ? WHERE id = ?").bind(v.name, v.phone, customer.id).run();
  else customer = await db.prepare("INSERT INTO customers (name, email, phone) VALUES (?, ?, ?) RETURNING id").bind(v.name, v.email, v.phone).first();

  const ip = request.headers.get("CF-Connecting-IP") || "";
  const booking = await db.prepare(
    `INSERT INTO bookings (customer_id, kit_id, plan, status, address, zip, delivery_date, notes, deposit_cents, delivery_fee_cents,
       rate_first_cents, rate_recurring_cents, agreement_version, signed_name, signed_at, signed_ip, source, hold_expires_at,
       est_return_date, manage_token)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'online', datetime('now', ?), NULLIF(?, ''), ?) RETURNING id`)
    .bind(customer.id, kitId, v.plan, v.address, v.zip, v.date, v.notes, deposit, zone.delivery_fee_cents, r.first, r.recurring,
      s.agreement_version || null, v.signed_name, ip, `+${HOLD_MINUTES} minutes`, v.est_return, newToken()).first();

  // Two customers racing for the same kit: the earlier booking wins.
  const clash = await kitConflict(db, { kitId, start: v.date, end: windowEnd, bufferDays: s.buffer_days, excludeId: booking.id });
  if (clash && clash.id < booking.id) {
    await db.prepare("UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE id = ?").bind(booking.id).run();
    return json(409, { ok: false, msg: "Sorry, that day was just taken. Please pick another day.", refresh: true });
  }

  let sub;
  try {
    sub = await createRentalSubscription(env, db, {
      bookingId: booking.id, plan: v.plan, firstCents: r.first, recurringCents: r.recurring,
      setupCents: deposit + zone.delivery_fee_cents, deliveryDate: v.date, customerName: v.name, origin: url.origin,
    });
  } catch (e) {
    console.error("start booking:", e && e.message);
    await db.prepare("UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE id = ?").bind(booking.id).run();
    return json(502, { ok: false, msg: "Sorry, we couldn't reach PayPal. Please try again in a few minutes." });
  }
  await db.batch([
    db.prepare("UPDATE bookings SET paypal_plan_id = ?, paypal_subscription_id = ?, billing_status = 'APPROVAL_PENDING' WHERE id = ?")
      .bind(sub.planId, sub.subscriptionId, booking.id),
    db.prepare("INSERT INTO booking_events (booking_id, by_email, action, detail) VALUES (?, ?, 'created', ?)")
      .bind(booking.id, v.email, `online, ${v.plan}, delivery ${v.date}, agreement signed by ${v.signed_name}`),
  ]);
  return json(200, { ok: true, bookingId: booking.id, subscriptionId: sub.subscriptionId });
}

// Called by the page after PayPal approval. The webhook does the same thing if the customer closes the tab.
async function approve(request, env) {
  const b = await request.json().catch(() => ({}));
  const bookingId = Number(b.bookingId), subId = String(b.subscriptionId || "");
  const row = await env.DB.prepare("SELECT id, paypal_subscription_id FROM bookings WHERE id = ?").bind(bookingId).first();
  if (!row || !subId || row.paypal_subscription_id !== subId) return json(400, { ok: false, msg: "Booking not found." });
  const s = await getSubscription(env, subId);
  if (!s.ok || s.data.custom_id !== String(bookingId)) return json(502, { ok: false, msg: "We couldn't confirm the payment with PayPal yet." });
  if (!["ACTIVE", "APPROVED"].includes(s.data.status)) return json(402, { ok: false, msg: "The payment wasn't completed. Please try again." });
  await confirmBooking(env, bookingId, s.data.status, "customer");
  return json(200, { ok: true });
}

export async function confirmBooking(env, bookingId, billingStatus, by) {
  const db = env.DB;
  const r = await db.prepare(
    `UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL, billing_status = ?, updated_at = datetime('now')
      WHERE id = ? AND status = 'pending' RETURNING id`).bind(billingStatus, bookingId).first();
  if (!r) { await db.prepare("UPDATE bookings SET billing_status = ? WHERE id = ?").bind(billingStatus, bookingId).run(); return; }
  await db.prepare("INSERT INTO booking_events (booking_id, by_email, action, detail) VALUES (?, ?, 'confirmed', ?)")
    .bind(bookingId, by, `PayPal subscription ${billingStatus}`).run();
  await sendConfirmation(env, bookingId);
}

const myLink = (b) => `https://3totes.com/my/${b.manage_token}`;

async function sendConfirmation(env, id) {
  const b = await env.DB.prepare(
    `SELECT b.*, c.name, c.email, c.phone FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = ?`).bind(id).first();
  if (!b) return;
  const planLine = b.plan === "moving"
    ? `Moving plan: ${money(b.rate_first_cents)} for the first 2 weeks, then ${money(b.rate_recurring_cents)} per week until we pick up.`
    : `Storage plan: ${money(b.rate_recurring_cents)} per month until we pick up.`;
  const text = `Hi ${b.name},

Your tote rental is booked. Booking #${b.id}.

DELIVERY: ${niceDate(b.delivery_date)}, first thing in the morning
ADDRESS: ${b.address}, ${b.zip}${b.est_return_date ? `\nYOUR ESTIMATED PICKUP: ${niceDate(b.est_return_date)} (just an estimate, change it anytime)` : ""}

${planLine}
Rental billing starts on your delivery day and renews automatically through PayPal.
Paid today: ${money(b.deposit_cents)} refundable deposit${b.delivery_fee_cents ? ` + ${money(b.delivery_fee_cents)} delivery` : ""}.

YOUR KIT: 12 totes with lids, a hand truck, moving blankets, furniture sliders, lifting straps and load straps.

YOUR BOOKING PAGE (schedule pickup, update your estimate):
${myLink(b)}

When you're done, schedule your pickup on that page. Please have the totes EMPTY and everything together.
We pick up the empty totes and equipment; we don't move your belongings.

Your deposit is refunded after pickup and a quick check of the equipment.

Thanks!
Totes Totes Totes
3totes.com
`;
  const owner = ownerEmail(env);
  await trySend(env, { to: b.email, subject: `Your tote rental is booked: ${niceDate(b.delivery_date)}`, text,
    replyTo: owner ? `<${owner}>` : undefined });
  if (owner) await trySend(env, { to: owner, fromName: "3totes bookings",
    subject: `New booking #${b.id}: ${b.name}, ${b.delivery_date}`,
    text: `New online booking #${b.id}\n\n${b.name} | ${b.phone} | ${b.email}\n${b.address}, ${b.zip}\nPlan: ${b.plan}\nDelivery: ${niceDate(b.delivery_date)}\nEstimated pickup: ${b.est_return_date ? niceDate(b.est_return_date) : "-"}\nNotes: ${b.notes || "-"}\n\nhttps://3totes.com/admin/bookings/${b.id}\n` });
}

// ---------- PayPal webhook ----------

async function webhook(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.DB || !paypalReady(env)) return new Response("not ready", { status: 503 });
  const event = await request.json().catch(() => null);
  if (!event || !event.id || !event.event_type) return new Response("bad request", { status: 400 });
  if (!(await verifyWebhook(env, request, event))) { console.warn("webhook: signature check failed"); return new Response("forbidden", { status: 403 }); }

  const db = env.DB;
  await ensureSchema(db);
  const fresh = await db.prepare("INSERT OR IGNORE INTO webhook_events (id, type) VALUES (?, ?)").bind(event.id, event.event_type).run();
  if (!fresh.meta.changes) return new Response("ok"); // already handled (PayPal retries)

  try { await handleEvent(env, event); }
  catch (e) {
    console.error("webhook handler:", e && e.stack);
    await db.prepare("DELETE FROM webhook_events WHERE id = ?").bind(event.id).run(); // let PayPal retry
    return new Response("error", { status: 500 });
  }
  return new Response("ok");
}

async function bookingBySub(db, subId) {
  if (!subId) return null;
  return db.prepare("SELECT * FROM bookings WHERE paypal_subscription_id = ?").bind(subId).first();
}

async function handleEvent(env, ev) {
  const db = env.DB, r = ev.resource || {}, type = ev.event_type;
  const log = (id, action, detail) => db.prepare("INSERT INTO booking_events (booking_id, by_email, action, detail) VALUES (?, 'paypal', ?, ?)")
    .bind(id, action, detail).run();

  if (type === "BILLING.SUBSCRIPTION.ACTIVATED") {
    const b = await bookingBySub(db, r.id);
    if (b) await confirmBooking(env, b.id, "ACTIVE", "paypal");
    return;
  }
  if (type === "PAYMENT.SALE.COMPLETED") {
    const b = await bookingBySub(db, r.billing_agreement_id);
    if (!b) return;
    const cents = Math.round(Number((r.amount && r.amount.total) || 0) * 100);
    const hasSetup = await db.prepare("SELECT 1 FROM payments WHERE booking_id = ? AND kind = 'setup'").bind(b.id).first();
    const kind = !hasSetup && cents === b.deposit_cents + b.delivery_fee_cents ? "setup" : "rental";
    await db.prepare("INSERT OR IGNORE INTO payments (booking_id, kind, amount_cents, paypal_id, status) VALUES (?, ?, ?, ?, ?)")
      .bind(b.id, kind, cents, r.id, r.state || "completed").run();
    await log(b.id, "payment", `${kind === "setup" ? "deposit + delivery" : "rental"} ${money(cents)} received`);
    return;
  }
  if (type.startsWith("BILLING.SUBSCRIPTION.")) {
    const b = await bookingBySub(db, r.id);
    if (!b) return;
    const status = String(r.status || type.split(".").pop());
    await db.prepare("UPDATE bookings SET billing_status = ? WHERE id = ?").bind(status, b.id).run();
    const label = { "BILLING.SUBSCRIPTION.PAYMENT.FAILED": "PAYMENT FAILED", "BILLING.SUBSCRIPTION.SUSPENDED": "billing suspended",
      "BILLING.SUBSCRIPTION.CANCELLED": "billing cancelled", "BILLING.SUBSCRIPTION.EXPIRED": "billing expired" }[type] || type;
    await log(b.id, "billing", label);
    if (["BILLING.SUBSCRIPTION.PAYMENT.FAILED", "BILLING.SUBSCRIPTION.SUSPENDED"].includes(type) && ownerEmail(env)) {
      await trySend(env, { to: ownerEmail(env), fromName: "3totes bookings", subject: `Booking #${b.id}: ${label}`,
        text: `PayPal reports "${label}" for booking #${b.id} (delivery ${b.delivery_date}).\n\nhttps://3totes.com/admin/bookings/${b.id}\n` });
    }
  }
}

// ---------- customer booking page (/my/<token>) ----------

const MY_STATUS = {
  pending: "Waiting for payment", confirmed: "Booked", delivered: "Delivered", pickup_requested: "Pickup scheduled",
  returned: "Picked up", closed: "Complete", cancelled: "Cancelled",
};

async function myBooking(db, token) {
  return db.prepare(`SELECT b.*, c.name, c.email, c.phone FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.manage_token = ?`).bind(token).first();
}

// Customers can schedule/change pickup while the rental is active and the current pickup day hasn't arrived.
function pickupEditable(b) {
  if (!["confirmed", "delivered", "pickup_requested"].includes(b.status)) return false;
  return !b.pickup_date || b.pickup_date > today();
}
const earliestPickup = (b, s) => {
  const lead = addDays(today(), Math.max(1, Number(s.lead_days) || 1));
  const afterDrop = addDays(b.delivery_date, 1);
  return lead > afterDrop ? lead : afterDrop;
};

async function myPage(env, s, token, url) {
  const b = await myBooking(env.DB, token);
  if (!b) return new Response(`${PAGE_HEAD("Booking not found")}<main class="narrow center"><h1 class="marker">Booking not found</h1><p>Check the link in your confirmation email, or <a href="/#contact">contact us</a>.</p></main></body></html>`,
    { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  const editable = pickupEditable(b);
  const min = earliestPickup(b, s), max = addDays(today(), 365);
  const flash = url.searchParams.get("msg") || "";
  const planLine = b.plan === "moving"
    ? `Moving plan: ${money(b.rate_first_cents)} for the first 2 weeks, then ${money(b.rate_recurring_cents)}/week`
    : `Storage plan: ${money(b.rate_recurring_cents)}/month`;
  const pickupBlock = b.pickup_date
    ? `<p class="big">Pickup: <b>${esc(niceDate(b.pickup_date))}</b></p><p class="muted">Please have all totes <b>empty</b> and everything together by morning. We pick up the empty totes and equipment; we don't move your belongings.</p>`
    : `<p>No pickup scheduled yet. Pick a day when you're done.</p>`;
  return new Response(`${PAGE_HEAD("Your booking | Totes Totes Totes")}
<main class="narrow">
  <a href="/" class="home"><img src="/logo.svg" alt="Totes Totes Totes" class="logo small"></a>
  <h1 class="marker">Hi ${esc(b.name.split(" ")[0])}!</h1>
  ${flash ? `<p class="card ok">${esc(flash)}</p>` : ""}
  <section class="card"><h2>Booking #${b.id}</h2>
    <p>Status: <b>${esc(MY_STATUS[b.status] || b.status)}</b></p>
    <p>Delivery: ${esc(niceDate(b.delivery_date))}, first thing in the morning<br>${esc(b.address)}, ${esc(b.zip)}</p>
    ${b.rate_recurring_cents ? `<p class="muted">${esc(planLine)}</p>` : ""}
  </section>
  ${["cancelled", "returned", "closed", "pending"].includes(b.status) ? "" : `
  <section class="card"><h2>Pickup</h2>
    ${pickupBlock}
    ${editable ? `<form id="pick" class="row">
        <input type="date" id="pick-date" min="${min}" max="${max}" value="${esc(b.pickup_date && b.pickup_date >= min ? b.pickup_date : "")}" required>
        <button>${b.pickup_date ? "Change pickup day" : "Schedule pickup"}</button></form>
      ${b.pickup_date ? `<p><button type="button" id="unpick" class="link">Cancel my pickup request</button></p>` : ""}
      <p class="muted">Billing stops once we've picked everything up.</p>`
      : b.pickup_date ? `<p class="muted">Need to change today's pickup? <a href="/#contact">Contact us</a>.</p>` : ""}
    <p id="pick-msg" class="msg"></p>
  </section>
  ${b.pickup_date ? "" : `<section class="card"><h2>Your estimate</h2>
    <p class="muted">Not sure yet? Tell us roughly when you'll be done so we can plan. It doesn't schedule anything.</p>
    <form id="est" class="row"><input type="date" id="est-date" min="${addDays(b.delivery_date, 1)}" max="${max}" value="${esc(b.est_return_date || "")}"><button>Save estimate</button></form>
    <p id="est-msg" class="msg"></p></section>`}`}
  <p class="muted center-text">Questions? <a href="/#contact">Contact us</a>.</p>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id), base = location.pathname.replace("/my/", "/api/my/");
  const post = (what, body, msgId) => fetch(base + "/" + what, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json()).catch(() => ({ ok: false, msg: "Something went wrong. Please try again." }))
    .then((r) => { if (r.ok) location.href = location.pathname + "?msg=" + encodeURIComponent(r.msg); else { const e = $(msgId); e.textContent = r.msg; e.className = "msg err"; } });
  $("pick") && $("pick").addEventListener("submit", (e) => { e.preventDefault(); post("pickup", { date: $("pick-date").value }, "pick-msg"); });
  $("unpick") && $("unpick").addEventListener("click", () => { if (confirm("Cancel your pickup request?")) post("cancel_pickup", {}, "pick-msg"); });
  $("est") && $("est").addEventListener("submit", (e) => { e.preventDefault(); post("estimate", { date: $("est-date").value }, "est-msg"); });
})();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" } });
}

async function myAction(request, env, s, token, action) {
  const db = env.DB;
  const b = await myBooking(db, token);
  if (!b) return json(404, { ok: false, msg: "Booking not found." });
  const body = await request.json().catch(() => ({}));
  const date = String(body.date || "").trim();
  const log = (act, detail) => db.prepare("INSERT INTO booking_events (booking_id, by_email, action, detail) VALUES (?, ?, ?, ?)").bind(b.id, b.email || "customer", act, detail).run();
  const owner = ownerEmail(env);

  if (action === "estimate") {
    if (b.pickup_date) return json(400, { ok: false, msg: "Your pickup is already scheduled." });
    if (date && (!isDate(date) || date <= b.delivery_date || date > addDays(today(), 365))) return json(400, { ok: false, msg: "Pick a date after your delivery day." });
    await db.prepare("UPDATE bookings SET est_return_date = NULLIF(?, ''), updated_at = datetime('now') WHERE id = ?").bind(date, b.id).run();
    await log("estimate", date ? `customer estimate ${date}` : "customer cleared estimate");
    return json(200, { ok: true, msg: date ? "Thanks! We saved your estimate." : "Estimate cleared." });
  }

  if (!pickupEditable(b)) return json(409, { ok: false, msg: "This pickup can't be changed online anymore. Please contact us." });

  if (action === "cancel_pickup") {
    if (!b.pickup_date) return json(400, { ok: false, msg: "No pickup is scheduled." });
    await db.prepare(`UPDATE bookings SET pickup_date = NULL, status = CASE WHEN status = 'pickup_requested' THEN 'delivered' ELSE status END,
      updated_at = datetime('now') WHERE id = ?`).bind(b.id).run();
    await log("pickup", `customer cancelled pickup (was ${b.pickup_date})`);
    if (owner) await trySend(env, { to: owner, fromName: "3totes bookings", subject: `Pickup cancelled: booking #${b.id}, ${b.name}`,
      text: `${b.name} cancelled their pickup for ${niceDate(b.pickup_date)}.\n\nhttps://3totes.com/admin/bookings/${b.id}\n` });
    return json(200, { ok: true, msg: "Your pickup request was cancelled." });
  }

  // action === "pickup"
  const min = earliestPickup(b, s);
  if (!isDate(date)) return json(400, { ok: false, msg: "Pick a pickup day." });
  if (date < min) return json(400, { ok: false, msg: `The earliest pickup day is ${niceDate(min)}.` });
  if (date > addDays(today(), 365)) return json(400, { ok: false, msg: "Pick a day within the next year." });
  await db.prepare(`UPDATE bookings SET pickup_date = ?, est_return_date = ?, status = CASE WHEN status = 'delivered' THEN 'pickup_requested' ELSE status END,
    updated_at = datetime('now') WHERE id = ?`).bind(date, date, b.id).run();
  await log("pickup", b.pickup_date ? `customer moved pickup ${b.pickup_date} → ${date}` : `customer scheduled pickup ${date}`);
  await trySend(env, { to: b.email, subject: `Pickup scheduled: ${niceDate(date)}`, replyTo: owner ? `<${owner}>` : undefined,
    text: `Hi ${b.name},\n\nYour pickup is scheduled for ${niceDate(date)}.\n\nPlease have all totes EMPTY and everything together by morning:\n12 totes with lids, the hand truck, moving blankets, furniture sliders, lifting straps and load straps.\nWe pick up the empty totes and equipment; we don't move your belongings.\n\nNeed to change it? ${myLink(b)}\n\nThanks!\nTotes Totes Totes\n` });
  if (owner) await trySend(env, { to: owner, fromName: "3totes bookings", subject: `Pickup ${b.pickup_date ? "changed" : "scheduled"}: ${date}, booking #${b.id}`,
    text: `${b.name} ${b.pickup_date ? `moved pickup from ${niceDate(b.pickup_date)} to` : "scheduled pickup for"} ${niceDate(date)}.\n${b.address}, ${b.zip} | ${b.phone}\n\nhttps://3totes.com/admin/bookings/${b.id}\n` });
  return json(200, { ok: true, msg: `Pickup scheduled for ${niceDate(date)}. We sent you a confirmation email.` });
}

// ---------- pages ----------

const PAGE_HEAD = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<link rel="icon" href="/logo.svg" type="image/svg+xml"><style>${CSS}</style></head><body>`;

function comingSoon() {
  return new Response(`${PAGE_HEAD("Book | Totes Totes Totes")}<main class="narrow center">
    <a href="/"><img src="/logo.svg" alt="Totes Totes Totes" class="logo"></a>
    <h1 class="marker">Online booking is coming soon</h1>
    <p>Want totes sooner? <a href="/#contact">Contact us</a> and we'll set you up.</p></main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function bookPage(env, s, url) {
  const preview = s.online_booking !== "on";
  const agreement = s.agreement_text || "[Rental agreement text has not been added yet. Add it in admin Settings before turning online booking on.]";
  const cfg = {
    clientId: String(env.PAYPAL_CLIENT_ID || "").trim(),
    preview: preview ? url.searchParams.get("preview") : "",
    deposit: Number(s.deposit_cents), movingFirst: Number(s.moving_first_cents), movingWeekly: Number(s.moving_weekly_cents),
    storageMonthly: Number(s.storage_monthly_cents), done: url.searchParams.get("done") === "1",
  };
  return new Response(`${PAGE_HEAD("Book your totes | Totes Totes Totes")}
${preview ? `<div class="banner">PREVIEW: online booking is OFF. Payments use the PayPal ${String(env.PAYPAL_ENV || "").trim() === "live" ? "<b>LIVE</b>" : "sandbox"}.</div>` : ""}
<main class="narrow">
  <a href="/" class="home"><img src="/logo.svg" alt="Totes Totes Totes" class="logo small"></a>
  <h1 class="marker">Book your totes</h1>
  <p class="lede">12 totes with lids, a hand truck, moving blankets, furniture sliders and straps. We drop them off, you fill them up, and we pick up the empties when you're done.</p>

  <div id="done" class="card ok" hidden><h2>You're booked!</h2><p>Check your email for the details. We'll see you first thing in the morning on your delivery day.</p></div>

  <form id="f" novalidate>
  <section class="card" id="s-zip"><h2><span>1</span> Where are we delivering?</h2>
    <label>Zip code <input id="zip" inputmode="numeric" maxlength="5" autocomplete="postal-code" required></label>
    <p id="zip-msg" class="msg"></p>
    <div id="wait" hidden><p>We don't deliver there yet. Leave your email and we'll let you know when we do.</p>
      <div class="row"><input id="wait-email" type="email" placeholder="you@example.com"><button type="button" id="wait-btn">Notify me</button></div></div>
  </section>

  <section class="card" id="s-plan" hidden><h2><span>2</span> Pick a plan</h2>
    <label class="choice"><input type="radio" name="plan" value="moving" checked> <b>Moving</b>: <span id="p-moving"></span></label>
    <label class="choice"><input type="radio" name="plan" value="storage"> <b>Storage</b>: <span id="p-storage"></span></label>
  </section>

  <section class="card" id="s-date" hidden><h2><span>3</span> Pick your delivery day</h2>
    <p class="muted">We drop off first thing in the morning. Keep the totes as long as you need.</p>
    <div id="cal"></div><p id="date-msg" class="msg"></p>
    <label id="est-wrap" hidden>When do you think you'll be done? <small>(optional estimate, you can change it later)</small>
      <input id="est" type="date"></label>
  </section>

  <section class="card" id="s-info" hidden><h2><span>4</span> Your details</h2>
    <label>Name <input id="name" maxlength="100" autocomplete="name" required></label>
    <label>Phone <input id="phone" type="tel" maxlength="30" autocomplete="tel" required></label>
    <label>Email <input id="email" type="email" maxlength="200" autocomplete="email" required></label>
    <label>Delivery address <input id="address" maxlength="200" autocomplete="street-address" required></label>
    <label>Notes for the driver <small>(optional: gate code, where to leave the kit)</small> <textarea id="notes" maxlength="1000"></textarea></label>
  </section>

  <section class="card" id="s-sign" hidden><h2><span>5</span> Rental agreement</h2>
    <div class="agreement" tabindex="0">${esc(agreement).replace(/\n/g, "<br>")}</div>
    <label class="choice"><input type="checkbox" id="agree"> I have read and agree to the rental agreement.</label>
    <label>Type your full name to sign <input id="signed" maxlength="100" autocomplete="name"></label>
  </section>

  <section class="card" id="s-pay" hidden><h2><span>6</span> Review and pay</h2>
    <div id="summary"></div>
    <p id="pay-msg" class="msg"></p>
    <div id="paypal"></div>
  </section>
  </form>
</main>
<script>window.BOOK=${JSON.stringify(cfg).replace(/</g, "\\u003c")};</script>
<script>${CLIENT_JS}</script></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...(preview ? { "x-robots-tag": "noindex" } : {}) } });
}

const CLIENT_JS = String.raw`
(() => {
const C = window.BOOK, $ = (id) => document.getElementById(id);
const q = C.preview ? "preview=" + encodeURIComponent(C.preview) : "";
const api = (p, extra) => "/api/book/" + p + "?" + [q, extra].filter(Boolean).join("&");
const money = (c) => "$" + (c / 100).toFixed(2);
const nice = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const st = { zip: "", fee: 0, plan: "moving", date: "", dates: [] };
const show = (id) => { $(id).hidden = false; };
const msg = (id, t, err) => { const e = $(id); e.textContent = t || ""; e.className = "msg" + (err ? " err" : ""); };

if (C.done) { $("done").hidden = false; $("f").hidden = true; return; }
$("p-moving").textContent = money(C.movingFirst) + " for the first 2 weeks, then " + money(C.movingWeekly) + "/week";
$("p-storage").textContent = money(C.storageMonthly) + "/month";

$("zip").addEventListener("input", async (e) => {
  const z = e.target.value.replace(/\D/g, "").slice(0, 5); e.target.value = z;
  $("wait").hidden = true; msg("zip-msg", "");
  if (z.length !== 5) return;
  const r = await fetch(api("zip", "zip=" + z)).then((r) => r.json()).catch(() => ({}));
  if (!r.ok) return msg("zip-msg", r.msg || "Something went wrong.", true);
  if (!r.served) { $("wait").hidden = false; return; }
  st.zip = z; st.fee = r.fee_cents;
  msg("zip-msg", "We deliver to " + z + "! " + (r.fee_cents ? "Delivery fee: " + money(r.fee_cents) + "." : "Free delivery."));
  show("s-plan"); show("s-date"); loadDates();
});
$("wait-btn").addEventListener("click", async () => {
  const r = await fetch("/api/book/waitlist", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: $("wait-email").value, zip: $("zip").value }) }).then((r) => r.json()).catch(() => ({}));
  $("wait").innerHTML = "<p>" + (r.msg || "Something went wrong.") + "</p>";
});
document.querySelectorAll("input[name=plan]").forEach((r) => r.addEventListener("change", () => { st.plan = r.value; st.date = ""; loadDates(); summary(); }));

async function loadDates() {
  $("cal").innerHTML = "<p class='muted'>Loading available days...</p>";
  const r = await fetch(api("dates", "plan=" + st.plan)).then((r) => r.json()).catch(() => ({}));
  if (!r.ok) { $("cal").innerHTML = ""; return msg("date-msg", r.msg || "Couldn't load dates.", true); }
  st.dates = r.dates; renderCal(r.first, r.last);
  if (!r.dates.length) msg("date-msg", "Sorry, every kit is booked right now. Please check back soon.", true); else msg("date-msg", "");
}
function renderCal(first, last) {
  const avail = new Set(st.dates);
  const d0 = new Date(first + "T12:00:00Z"); d0.setUTCDate(d0.getUTCDate() - d0.getUTCDay());
  let html = "<div class='cal'>" + ["S","M","T","W","T","F","S"].map((d) => "<b>" + d + "</b>").join("");
  let month = "";
  for (let d = new Date(d0); d.toISOString().slice(0, 10) <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const ymd = d.toISOString().slice(0, 10);
    const m = d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    if (d.getUTCDay() === 0 && m !== month) { html += "<i>" + m + "</i>"; month = m; }
    const ok = avail.has(ymd);
    html += ok ? "<button type='button' data-d='" + ymd + "' class='" + (ymd === st.date ? "sel" : "") + "'>" + d.getUTCDate() + "</button>"
               : "<span class='" + (ymd < first ? "past" : "off") + "'>" + d.getUTCDate() + "</span>";
  }
  $("cal").innerHTML = html + "</div>";
  $("cal").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    st.date = b.dataset.d; renderCal(first, last); msg("date-msg", "Delivery: " + nice(st.date) + ", first thing in the morning.");
    const nx = new Date(st.date + "T12:00:00Z"); nx.setUTCDate(nx.getUTCDate() + 1);
    $("est").min = nx.toISOString().slice(0, 10); if ($("est").value && $("est").value < $("est").min) $("est").value = "";
    $("est-wrap").hidden = false;
    show("s-info"); show("s-sign"); show("s-pay"); summary();
  }));
}
function summary() {
  if (!st.date) { $("summary").innerHTML = ""; return; }
  const plan = st.plan === "moving"
    ? "<li>On " + nice(st.date) + ": " + money(C.movingFirst) + " (first 2 weeks)</li><li>Then " + money(C.movingWeekly) + " every week until pickup</li>"
    : "<li>On " + nice(st.date) + ": " + money(C.storageMonthly) + ", then monthly until pickup</li>";
  $("summary").innerHTML = "<ul class='sum'><li><b>Today: " + money(C.deposit + st.fee) + "</b> (" + money(C.deposit) + " refundable deposit" +
    (st.fee ? " + " + money(st.fee) + " delivery" : "") + ")</li>" + plan + "</ul><p class='muted'>Cancel billing anytime by scheduling your pickup.</p>";
}
function form() {
  return { zip: st.zip, plan: st.plan, date: st.date, est_return: $("est").value, name: $("name").value, phone: $("phone").value, email: $("email").value,
    address: $("address").value, notes: $("notes").value, agree: $("agree").checked, signed_name: $("signed").value };
}
function check() {
  const v = form();
  if (!v.date) return "Pick a delivery day.";
  if (!v.name.trim() || !v.phone.trim() || !v.email.trim() || !v.address.trim()) return "Please fill in your name, phone, email and address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) return "Please enter a valid email address.";
  if (!v.agree || v.signed_name.trim().length < 2) return "Please check the agreement box and type your name to sign.";
  return "";
}

let booking = null;
function loadPayPal() {
  if (!C.clientId) return msg("pay-msg", "Payments are not set up yet.", true);
  const s = document.createElement("script");
  s.src = "https://www.paypal.com/sdk/js?client-id=" + encodeURIComponent(C.clientId) + "&vault=true&intent=subscription&currency=USD";
  s.onload = () => paypal.Buttons({
    style: { layout: "vertical", label: "subscribe" },
    onClick: (data, actions) => { const e = check(); if (e) { msg("pay-msg", e, true); return actions.reject(); } msg("pay-msg", ""); return actions.resolve(); },
    createSubscription: async () => {
      const r = await fetch(api("start"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form()) })
        .then((r) => r.json()).catch(() => ({ ok: false }));
      if (!r.ok) { msg("pay-msg", r.msg || "Something went wrong.", true); if (r.refresh) loadDates(); throw new Error("start failed"); }
      booking = r; return r.subscriptionId;
    },
    onApprove: async (data) => {
      msg("pay-msg", "Confirming your booking...");
      const r = await fetch(api("approve"), { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId: booking.bookingId, subscriptionId: data.subscriptionID }) }).then((r) => r.json()).catch(() => ({}));
      if (r.ok) { $("f").hidden = true; $("done").hidden = false; window.scrollTo(0, 0); }
      else msg("pay-msg", (r.msg || "We couldn't confirm yet.") + " If you were charged, your booking will confirm by email shortly.", true);
    },
    onCancel: () => msg("pay-msg", "Payment cancelled. Your day is held for a few minutes if you want to try again."),
    onError: () => { if (!$("pay-msg").textContent) msg("pay-msg", "PayPal had a problem. Please try again.", true); },
  }).render("#paypal");
  document.head.appendChild(s);
}
loadPayPal();
})();
`;

const CSS = `
:root{--ink:#111;--muted:#555;--line:#ddd;--bg:#fafaf7;--card:#fff;--yellow:#f5c400;--red:#b3261e;--green:#1e7b34}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@font-face{font-family:"Permanent Marker";src:url("/fonts/PermanentMarker-Regular.ttf") format("truetype");font-display:swap}
.marker{font-family:"Permanent Marker",cursive;font-weight:400}
main.narrow{max-width:640px;margin:0 auto;padding:24px 16px 64px}main.center{text-align:center;padding-top:15vh}
.logo{width:min(220px,60vw);height:auto}.logo.small{width:110px}.home{display:inline-block}
h1{font-size:clamp(1.8rem,6vw,2.4rem);margin:.3em 0}.lede{color:var(--muted)}
.banner{background:var(--yellow);text-align:center;padding:6px 12px;font-size:.9rem;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-top:16px}
.card.ok{border-color:var(--green)}.card h2{font-size:1.15rem;margin:0 0 10px;display:flex;align-items:center;gap:10px}
.card h2 span{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--yellow);font-size:.95rem}
label{display:grid;gap:4px;margin:10px 0;font-size:.95rem}label.choice{display:flex;gap:10px;align-items:baseline;cursor:pointer}
input:not([type=radio]):not([type=checkbox]),textarea{font:inherit;padding:10px 12px;border:1px solid #bbb;border-radius:8px;width:100%;background:#fff}
textarea{min-height:80px}button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:8px;background:var(--yellow);color:var(--ink);cursor:pointer}
.row{display:flex;gap:8px}.muted,small{color:var(--muted)}.msg{min-height:1.2em;margin:6px 0 0}.msg.err{color:var(--red)}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center}.cal b{font-size:.8rem;color:var(--muted)}
.cal i{grid-column:1/-1;text-align:left;font-style:normal;font-weight:700;margin-top:8px}
.cal button,.cal span{padding:9px 0;border-radius:8px}.cal button{background:#fff;border:1.5px solid var(--ink)}.cal button:hover{background:#fff4bf}
.cal button.sel{background:var(--yellow)}.cal span.off{color:#bbb;text-decoration:line-through}.cal span.past{color:#ddd}
.agreement{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:12px;font-size:.9rem;background:#fcfcfa}
ul.sum{padding-left:20px}#paypal{margin-top:12px}
.big{font-size:1.15rem}.center-text{text-align:center;margin-top:24px}.row input{flex:1}
button.link{background:none;padding:0;color:#0b57d0;text-decoration:underline;font-weight:400}
`;
