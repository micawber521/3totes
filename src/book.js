// Customer online booking (/book) + PayPal webhook.
// Hidden behind the `online_booking` setting; while off, /book?preview=<booking_preview_key> still works
// so Christian can test end to end (sandbox).
import { ensureSchema, getSettings, kitBlocks, freeKit, kitConflict, newToken, addonPacksAvailable, addonState, packsFree, ADDON_PACK_SIZE, HUBS, hubName, hubWhere } from "./db.js";
import { paypalReady, createRentalSubscription, getSubscription, verifyWebhook, firstRenewalDate } from "./paypal.js";
import { trySend } from "./mail.js";
import { cancelFee, customerCanCancel, cancelBooking, cancelPolicyText } from "./cancel.js";

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

function addonRates(s, plan) {
  return plan === "moving"
    ? { first: Number(s.addon_moving_first_cents), recurring: Number(s.addon_moving_weekly_cents) }
    : { first: Number(s.addon_storage_monthly_cents), recurring: Number(s.addon_storage_monthly_cents) };
}
function rates(s, plan, packs = 0) {
  const base = plan === "moving"
    ? { first: Number(s.moving_first_cents), recurring: Number(s.moving_weekly_cents) }
    : { first: Number(s.storage_monthly_cents), recurring: Number(s.storage_monthly_cents) };
  const a = addonRates(s, plan);
  return { first: base.first + packs * a.first, recurring: base.recurring + packs * a.recurring };
}
const isSelf = (b) => b.fulfillment === "self";

async function availableDates(db, s, plan, packs = 0) {
  const lead = Math.max(1, Number(s.lead_days) || 1); // drop-off is first thing in the morning → never same day
  const horizon = Math.min(400, Math.max(30, Number(s.booking_horizon_days) || 180));
  const first = addDays(today(), lead), last = addDays(today(), horizon);
  const state = await kitBlocks(db, s.buffer_days);
  const extras = packs > 0 ? await addonState(db, s) : null;
  const out = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const end = addDays(d, WINDOW_DAYS[plan] - 1);
    if (freeKit(state, d, end) && (!extras || packsFree(extras, d, end) >= packs)) out.push(d);
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
  if (p === "/prices" && request.method === "GET") return pricesPage(env.DB);
  const my = p.match(/^\/my\/([0-9a-f]{48})$/);
  if (my && request.method === "GET") return myPage(env, s, my[1], url);
  const myApi = p.match(/^\/api\/my\/([0-9a-f]{48})\/(pickup|estimate|cancel_pickup|cancel_booking)$/);
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
    const packs = Math.max(0, Math.min(10, parseInt(url.searchParams.get("addons") || "0", 10) || 0));
    return json(200, { ok: true, plan, ...(await availableDates(env.DB, s, plan, packs)) });
  }
  if (p === "/api/book/addons" && request.method === "GET") {
    const plan = url.searchParams.get("plan") === "storage" ? "storage" : "moving";
    // Step 2 (before a date is picked): offer up to the total pool; the calendar then hides days without enough free.
    const max = (await addonState(env.DB, s)).pool;
    const a = addonRates(s, plan);
    return json(200, { ok: true, max: Math.min(max, 10), packSize: ADDON_PACK_SIZE, first: a.first, recurring: a.recurring });
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
  for (const k of ["zip", "plan", "date", "est_return", "name", "phone", "email", "address", "notes", "signed_name", "fulfillment", "hub"]) v[k] = String(b[k] ?? "").trim();
  const self = v.fulfillment === "self";
  if (self && !HUBS[v.hub]) return json(400, { ok: false, msg: "Pick which hub you'll get the kit from." });
  const packs = Number(b.addons || 0);
  if (!Number.isInteger(packs) || packs < 0 || packs > 10) return json(400, { ok: false, msg: "Pick how many extra tote packs you need." });

  if (!/^\d{5}$/.test(v.zip)) return json(400, { ok: false, msg: "Enter a 5-digit zip code." });
  const zone = self ? { delivery_fee_cents: 0 } : await db.prepare("SELECT zone, delivery_fee_cents FROM zones WHERE zip = ?").bind(v.zip).first();
  if (!zone) return json(400, { ok: false, msg: "Sorry, we don't deliver to that zip code yet. You can pick the kit up yourself instead." });
  if (!["moving", "storage"].includes(v.plan)) return json(400, { ok: false, msg: "Pick a plan." });
  if (!isDate(v.date)) return json(400, { ok: false, msg: "Pick a delivery day." });
  if (v.est_return && (!isDate(v.est_return) || v.est_return <= v.date || v.est_return > addDays(v.date, 365)))
    return json(400, { ok: false, msg: "Your estimated pickup date should be after the delivery day." });
  if (!v.name || !v.phone || !v.email || !v.address) return json(400, { ok: false, msg: "Please fill in your name, phone, email and address." });
  for (const k of Object.keys(LIMITS)) if (v[k].length > LIMITS[k]) return json(400, { ok: false, msg: `That ${k} is too long.` });
  if (!emailOk(v.email)) return json(400, { ok: false, msg: "Please enter a valid email address." });
  if (b.agree !== true || v.signed_name.length < 2) return json(400, { ok: false, msg: "Please read the rental agreement, check the box and type your name to sign." });
  if (!s.agreement_text && s.online_booking === "on") return json(503, { ok: false, msg: "Booking is temporarily unavailable." });

  const { dates } = await availableDates(db, s, v.plan, packs);
  if (!dates.includes(v.date)) return json(409, { ok: false, msg: "Sorry, that day was just taken. Please pick another day.", refresh: true });

  const r = rates(s, v.plan, packs);
  const deposit = (Number(s.deposit_cents) || 0) + packs * (Number(s.deposit_per_pack_cents) || 0);
  const windowEnd = addDays(v.date, WINDOW_DAYS[v.plan] - 1);
  if (packs > 0 && packs > await addonPacksAvailable(db, s, v.date, windowEnd))
    return json(409, { ok: false, msg: "Sorry, we don't have that many extra totes for those dates. Please pick fewer.", refreshAddons: true });
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
       est_return_date, manage_token, fulfillment, addon_packs, return_method, hub)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, NULLIF(?, ''), ?, ?, ?, ?, ?, ?, datetime('now'), ?, 'online', datetime('now', ?), NULLIF(?, ''), ?, ?, ?, ?, ?) RETURNING id`)
    .bind(customer.id, kitId, v.plan, v.address, v.zip, v.date, v.notes, deposit, zone.delivery_fee_cents, r.first, r.recurring,
      s.agreement_version || null, v.signed_name, ip, `+${HOLD_MINUTES} minutes`, v.est_return, newToken(),
      self ? "self" : "delivery", packs, self ? "dropoff" : "pickup", self ? v.hub : null).first();

  // Two customers racing for the same kit: the earlier booking wins.
  const clash = await kitConflict(db, { kitId, start: v.date, end: windowEnd, bufferDays: s.buffer_days, excludeId: booking.id });
  if (clash && clash.id < booking.id) {
    await db.prepare("UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL WHERE id = ?").bind(booking.id).run();
    return json(409, { ok: false, msg: "Sorry, that day was just taken. Please pick another day.", refresh: true });
  }

  let sub;
  try {
    sub = await createRentalSubscription(env, db, {
      bookingId: booking.id, plan: v.plan, recurringCents: r.recurring,
      setupCents: deposit + r.first + zone.delivery_fee_cents, deliveryDate: v.date, origin: url.origin,
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
      .bind(booking.id, v.email, `online, ${v.plan}, ${self ? "customer pickup" : "delivery"} ${v.date}${packs ? `, +${packs} tote pack${packs > 1 ? "s" : ""}` : ""}, agreement signed by ${v.signed_name}`),
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
    ? `Moving plan: ${money(b.rate_first_cents)} for the first 2 weeks (2-week minimum), then ${money(b.rate_recurring_cents)} per week until we pick up.`
    : `Storage plan: ${money(b.rate_recurring_cents)} per month until we pick up (1-month minimum). After the first month, we refund any unused full weeks of your last month after pickup.`;
  const text = `Hi ${b.name},

Your tote rental is booked. Booking #${b.id}.

${isSelf(b)
  ? `PICK UP YOUR KIT: ${niceDate(b.delivery_date)} at our ${hubWhere(b.hub)}. ${(await getSettings(env.DB)).pickup_location_text || ""}\nWhen you're done, bring it back to one of our hubs (free).`
  : `DELIVERY: ${niceDate(b.delivery_date)}, first thing in the morning\nADDRESS: ${b.address}, ${b.zip}`}${b.est_return_date ? `\nYOUR ESTIMATED PICKUP: ${niceDate(b.est_return_date)} (just an estimate, change it anytime)` : ""}

${planLine}
Paid today: ${money(b.deposit_cents + b.rate_first_cents + b.delivery_fee_cents)} = ${money(b.deposit_cents)} refundable deposit + ${money(b.rate_first_cents)} ${b.plan === "moving" ? "first 2 weeks" : "first month"}${b.delivery_fee_cents ? ` + ${money(b.delivery_fee_cents)} delivery` : ""}.
Your rental time starts on delivery day. If you still have the kit after ${b.plan === "moving" ? "2 weeks" : "1 month"}, PayPal renews it automatically starting ${niceDate(firstRenewalDate(b.plan, b.delivery_date))}.

CANCELLING: ${cancelPolicyText(await getSettings(env.DB))} Cancel from your booking page below.

YOUR KIT: 12 totes with lids${b.addon_packs ? ` + ${b.addon_packs * ADDON_PACK_SIZE} extra totes` : ""}, a hand truck, moving blankets, furniture sliders, lifting straps and load straps.
Moving? Take the kit with you anywhere in our service area. Moving out of the area? Return it to one of our hubs (Sikeston or Jackson) before you go.

YOUR BOOKING PAGE (schedule pickup, update your estimate):
${myLink(b)}

When you're done, schedule your pickup (or drop-off) on that page. Please have the totes EMPTY and everything together.
We pick up the empty totes and equipment; we don't move your belongings.

Your deposit is refunded at pickup, right after a quick onsite check of the equipment.

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
    const kind = hasSetup ? "rental" : "setup"; // the first sale on a subscription is the booking payment (setup fee)
    await db.prepare("INSERT OR IGNORE INTO payments (booking_id, kind, amount_cents, paypal_id, status) VALUES (?, ?, ?, ?, ?)")
      .bind(b.id, kind, cents, r.id, r.state || "completed").run();
    await log(b.id, "payment", `${kind === "setup" ? "booking payment (deposit + first period + delivery)" : "rental renewal"} ${money(cents)} received`);
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
    ? `Moving plan: ${money(b.rate_first_cents)} for the first 2 weeks (2-week minimum), then ${money(b.rate_recurring_cents)}/week`
    : `Storage plan: ${money(b.rate_recurring_cents)}/month (1-month minimum)`;
  const dropoff = b.return_method === "dropoff";
  const pickupBlock = b.pickup_date
    ? dropoff
      ? `<p class="big">Drop-off: <b>${esc(niceDate(b.pickup_date))}</b> at our ${esc(hubWhere(b.hub))}</p><p class="muted">${esc(s.pickup_location_text || "")} Please bring everything back with the totes <b>empty</b>.</p>`
      : `<p class="big">Pickup: <b>${esc(niceDate(b.pickup_date))}</b><br><small>${esc(b.pickup_address || b.address)}, ${esc(b.pickup_zip || b.zip)}</small></p><p class="muted">Please have all totes <b>empty</b> and everything together by morning. We pick up the empty totes and equipment; we don't move your belongings.</p>`
    : `<p>Nothing scheduled yet. When you're done, tell us where to pick up the kit, or bring it back to us yourself.</p>`;
  return new Response(`${PAGE_HEAD("Your booking | Totes Totes Totes")}
<main class="narrow">
  <a href="/" class="home"><img src="/logo.svg" alt="Totes Totes Totes" class="logo small"></a>
  <h1 class="marker">Hi ${esc(b.name.split(" ")[0])}!</h1>
  ${flash ? `<p class="card ok">${esc(flash)}</p>` : ""}
  <section class="card"><h2>Booking #${b.id}</h2>
    <p>Status: <b>${esc(MY_STATUS[b.status] || b.status)}</b></p>
    ${isSelf(b) ? `<p>You pick up the kit: ${esc(niceDate(b.delivery_date))} at our ${esc(hubWhere(b.hub))}<br><small>${esc(s.pickup_location_text || "")}</small></p>`
      : `<p>Delivery: ${esc(niceDate(b.delivery_date))}, first thing in the morning<br>${esc(b.address)}, ${esc(b.zip)}</p>`}
    ${b.addon_packs ? `<p>Extra totes: ${b.addon_packs * ADDON_PACK_SIZE} (${b.addon_packs} pack${b.addon_packs > 1 ? "s" : ""} of ${ADDON_PACK_SIZE})</p>` : ""}
    ${b.rate_recurring_cents ? `<p class="muted">${esc(planLine)}</p>` : ""}
    <p>Refundable deposit: <b>${money(b.deposit_cents)}</b>${b.deposit_settled_at
      ? `<br>Refunded ${money(b.deposit_refunded_cents)}${b.deposit_kept_cents ? ` (kept ${money(b.deposit_kept_cents)} for ${esc(b.deposit_kept_reason || "")})` : ""} on ${esc(niceDate(b.deposit_settled_at.slice(0, 10)))}`
      : `<br><span class="muted">Refunded at pickup, after a quick onsite check of the equipment.</span>`}</p>
  </section>
  ${["cancelled", "returned", "closed", "pending"].includes(b.status) ? "" : `
  <section class="card"><h2>Pickup</h2>
    ${pickupBlock}
    ${editable ? `<form id="pick">
        <label class="choice"><input type="radio" name="method" value="pickup"${dropoff ? "" : " checked"}> <span><b>Pick it up from me</b> (free, inside our service area)</span></label>
        <div id="pick-addr"${dropoff ? " hidden" : ""}>
          <label>Pickup address <small>(moved? enter your new address)</small> <input id="pick-address" maxlength="200" value="${esc(b.pickup_address || b.address)}"></label>
          <label>Zip <input id="pick-zip" inputmode="numeric" maxlength="5" value="${esc(b.pickup_zip || b.zip)}"></label>
        </div>
        <label class="choice"><input type="radio" name="method" value="dropoff"${dropoff ? " checked" : ""}> <span><b>I'll return it to a hub</b> (free). <small>Required if you're moving outside our service area.</small></span></label>
        <div id="pick-hub"${dropoff ? "" : " hidden"}><label>Which hub? <select id="hub">${Object.entries(HUBS).map(([k, n]) => `<option value="${k}"${(b.hub || Object.keys(HUBS)[0]) === k ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label></div>
        <label>Day <input type="date" id="pick-date" min="${min}" max="${max}" value="${esc(b.pickup_date && b.pickup_date >= min ? b.pickup_date : "")}" required></label>
        <button>${b.pickup_date ? "Update" : "Schedule"}</button></form>
      ${b.pickup_date ? `<p><button type="button" id="unpick" class="link">Cancel my ${dropoff ? "drop-off" : "pickup"}</button></p>` : ""}
      <p class="muted">Billing stops once we've picked everything up.${b.plan === "storage" ? " The first month is a minimum; after that, unused full weeks of your last month are refunded after pickup." : ""}</p>`
      : b.pickup_date ? `<p class="muted">Need to change today's pickup? <a href="/#contact">Contact us</a>.</p>` : ""}
    <p id="pick-msg" class="msg"></p>
  </section>
  ${b.pickup_date ? "" : `<section class="card"><h2>Your estimate</h2>
    <p class="muted">Not sure yet? Tell us roughly when you'll be done so we can plan. It doesn't schedule anything.</p>
    <form id="est" class="row"><input type="date" id="est-date" min="${addDays(b.delivery_date, 1)}" max="${max}" value="${esc(b.est_return_date || "")}"><button>Save estimate</button></form>
    <p id="est-msg" class="msg"></p></section>`}`}
  ${customerCanCancel(b, today()) ? (() => { const c = cancelFee(s, b.delivery_date, today()); return `
  <section class="card"><h2>Need to cancel?</h2>
    <p class="muted">${esc(cancelPolicyText(s))}</p>
    <p>Cancelling today: <b>${money(c.fee)} fee</b>. You get the rest back.</p>
    <button type="button" id="cancel-booking" data-fee="${money(c.fee)}">Cancel my booking</button>
    <p id="cancel-msg" class="msg"></p></section>`; })() : ""}
  <p class="muted center-text">Questions? <a href="/#contact">Contact us</a>.</p>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id), base = location.pathname.replace("/my/", "/api/my/");
  const post = (what, body, msgId) => fetch(base + "/" + what, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((r) => r.json()).catch(() => ({ ok: false, msg: "Something went wrong. Please try again." }))
    .then((r) => { if (r.ok) location.href = location.pathname + "?msg=" + encodeURIComponent(r.msg); else { const e = $(msgId); e.textContent = r.msg; e.className = "msg err"; } });
  document.querySelectorAll("input[name=method]").forEach((r) => r.addEventListener("change", () => { const d = r.value === "dropoff" && r.checked; $("pick-addr").hidden = d; $("pick-hub").hidden = !d; }));
  $("pick") && $("pick").addEventListener("submit", (e) => { e.preventDefault();
    const m = document.querySelector("input[name=method]:checked").value;
    post("pickup", { date: $("pick-date").value, method: m, address: $("pick-address").value, zip: $("pick-zip").value, hub: $("hub").value }, "pick-msg"); });
  $("unpick") && $("unpick").addEventListener("click", () => { if (confirm("Cancel your pickup request?")) post("cancel_pickup", {}, "pick-msg"); });
  $("est") && $("est").addEventListener("submit", (e) => { e.preventDefault(); post("estimate", { date: $("est-date").value }, "est-msg"); });
  $("cancel-booking") && $("cancel-booking").addEventListener("click", (e) => { if (confirm("Cancel your booking? The cancellation fee is " + e.target.dataset.fee + ".")) post("cancel_booking", {}, "cancel-msg"); });
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

  if (action === "cancel_booking") {
    if (!customerCanCancel(b, today())) return json(409, { ok: false, msg: "This booking can't be cancelled online anymore. Please contact us." });
    const { fee } = cancelFee(s, b.delivery_date, today());
    const r = await cancelBooking(env, db, b, { fee, by: b.email || "customer" });
    return json(r.ok ? 200 : 502, { ok: r.ok, msg: r.msg });
  }

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

  // action === "pickup": we collect at an address inside the service area, or the customer drops it off.
  const method = body.method === "dropoff" ? "dropoff" : "pickup";
  const hub = HUBS[body.hub] ? body.hub : (HUBS[b.hub] ? b.hub : Object.keys(HUBS)[0]);
  // Default to the address already on file (pickup address if they moved, else delivery address).
  const addr = String(body.address || b.pickup_address || b.address || "").trim().slice(0, 200), zip = String(body.zip || b.pickup_zip || b.zip || "").trim();
  const min = earliestPickup(b, s);
  if (!isDate(date)) return json(400, { ok: false, msg: "Pick a day." });
  if (date < min) return json(400, { ok: false, msg: `The earliest day is ${niceDate(min)}.` });
  if (date > addDays(today(), 365)) return json(400, { ok: false, msg: "Pick a day within the next year." });
  if (method === "pickup") {
    if (!addr || !/^\d{5}$/.test(zip)) return json(400, { ok: false, msg: "Enter the pickup address and a 5-digit zip." });
    const inArea = await db.prepare("SELECT 1 FROM zones WHERE zip = ?").bind(zip).first();
    if (!inArea) return json(400, { ok: false, msg: "That address is outside our service area, so we can't pick up there. Please choose \"I'll return it to a hub\" and drop the kit off at our Sikeston or Jackson hub before you leave." });
  }
  const label = method === "dropoff" ? "drop-off" : "pickup";
  await db.prepare(`UPDATE bookings SET pickup_date = ?, est_return_date = ?, return_method = ?, pickup_address = ?, pickup_zip = ?,
    hub = CASE WHEN ? = 'dropoff' THEN ? ELSE hub END,
    status = CASE WHEN status = 'delivered' THEN 'pickup_requested' ELSE status END, updated_at = datetime('now') WHERE id = ?`)
    .bind(date, date, method, method === "pickup" ? addr : null, method === "pickup" ? zip : null, method, hub, b.id).run();
  await log("pickup", `${b.pickup_date ? `customer changed to ${label}` : `customer scheduled ${label}`} ${date}${method === "pickup" ? ` at ${addr}, ${zip}` : ` at ${hubName(hub)} hub`}`);
  const where = method === "pickup" ? `We'll pick up at: ${addr}, ${zip}\n\nPlease have all totes EMPTY and everything together by morning.\nWe pick up the empty totes and equipment; we don't move your belongings.`
    : `Please bring the kit to our ${hubWhere(hub)} that day. ${s.pickup_location_text || ""}\nTotes should be EMPTY.`;
  const items = `12 totes with lids${b.addon_packs ? ` + ${b.addon_packs * ADDON_PACK_SIZE} extra totes` : ""}, the hand truck, moving blankets, furniture sliders, lifting straps and load straps.`;
  await trySend(env, { to: b.email, subject: `${label === "pickup" ? "Pickup" : "Drop-off"} scheduled: ${niceDate(date)}`, replyTo: owner ? `<${owner}>` : undefined,
    text: `Hi ${b.name},\n\nYour ${label} is scheduled for ${niceDate(date)}.\n\n${where}\n\nWhat comes back: ${items}\n\nNeed to change it? ${myLink(b)}\n\nThanks!\nTotes Totes Totes\n` });
  if (owner) await trySend(env, { to: owner, fromName: "3totes bookings", subject: `${label === "pickup" ? "Pickup" : "Drop-off"} ${b.pickup_date ? "changed" : "scheduled"}: ${date}, booking #${b.id}`,
    text: `${b.name}: ${label} on ${niceDate(date)}.\n${method === "pickup" ? `${addr}, ${zip}` : `Customer is bringing it to the ${hubName(hub)} hub.`} | ${b.phone}\n\nhttps://3totes.com/admin/bookings/${b.id}\n` });
  return json(200, { ok: true, msg: `${label === "pickup" ? "Pickup" : `Drop-off at our ${hubName(hub)} hub`} scheduled for ${niceDate(date)}. We sent you a confirmation email.` });
}

// ---------- public price list (/prices) ----------

async function pricesPage(db) {
  const items = (await db.prepare("SELECT * FROM price_items WHERE active = 1 ORDER BY sort, name").all()).results;
  const unit = (i) => i.pack_size > 1 ? `per pack of ${i.pack_size}` : i.kind === "item" ? "each" : "per pickup";
  const rows = items.map((i) => {
    const notes = [i.note, i.pack_size > 1 ? "Any missing or damaged piece means the whole pack is replaced." : ""].filter(Boolean);
    return `<div class="pi"><div class="pi-top"><b>${esc(i.name)}</b><span class="pi-price">${money(i.price_cents)} <small>${unit(i)}</small></span></div>
      ${notes.length ? `<p class="pi-note">${notes.map(esc).join(" ")}</p>` : ""}</div>`;
  }).join("");
  return new Response(`${PAGE_HEAD("Replacement prices | Totes Totes Totes")}<main class="narrow">
  <a href="/" class="home"><img src="/logo.svg" alt="Totes Totes Totes" class="logo small"></a>
  <h1 class="marker">Replacement prices</h1>
  <p class="lede">If something in your kit comes back missing, damaged or overly dirty, these charges come out of your deposit at pickup. Normal wear like light scuffs is fine.</p>
  <div class="card prices">${rows}</div>
  <p class="muted">Prices may change without notice. Charges above the deposit are billed separately.</p>
  <p class="muted center-text"><a href="/book">Book your totes</a> · <a href="/#contact">Contact us</a></p>
</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
    deposit: Number(s.deposit_cents), depositPerPack: Number(s.deposit_per_pack_cents) || 0, movingFirst: Number(s.moving_first_cents), movingWeekly: Number(s.moving_weekly_cents),
    storageMonthly: Number(s.storage_monthly_cents), done: url.searchParams.get("done") === "1", cancelText: cancelPolicyText(s),
  };
  return new Response(`${PAGE_HEAD("Book your totes | Totes Totes Totes")}
${preview ? `<div class="banner">PREVIEW: online booking is OFF. Payments use the PayPal ${String(env.PAYPAL_ENV || "").trim() === "live" ? "<b>LIVE</b>" : "sandbox"}.</div>` : ""}
<main class="narrow">
  <a href="/" class="home"><img src="/logo.svg" alt="Totes Totes Totes" class="logo small"></a>
  <h1 class="marker">Book your totes</h1>
  <p class="lede">12 totes with lids, a hand truck, moving blankets, furniture sliders and straps. We drop them off, you fill them up, and we pick up the empties when you're done.</p>

  <div id="done" class="card ok" hidden><h2>You're booked!</h2><p>Check your email for the details. We'll see you first thing in the morning on your delivery day.</p></div>

  <form id="f" novalidate>
  <section class="card" id="s-zip"><h2><span>1</span> Where are you?</h2>
    <label>Your zip code <input id="zip" inputmode="numeric" maxlength="5" autocomplete="postal-code" required></label>
    <p id="zip-msg" class="msg"></p>
    <div id="ful" hidden>
      <label class="choice" id="ful-del-wrap"><input type="radio" name="ful" value="delivery"> <span><b>Deliver to me</b> <small id="ful-del-note"></small></span></label>
      ${Object.keys(HUBS).length ? `<label class="choice"><input type="radio" name="ful" value="self"> <span><b>I'll pick it up</b> at ${Object.keys(HUBS).length > 1 ? "one of your hubs" : `your ${esc(Object.values(HUBS)[0])} hub`} and bring it back when I'm done (free)</span></label>` : ""}
      <label id="hub-wrap" hidden>Which hub? <select id="hub">${Object.entries(HUBS).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join("")}</select></label>
    </div>
    <div id="wait" hidden><p class="muted">We don't deliver there yet, but you can pick up the kit yourself. Want to know when we deliver to you?</p>
      <div class="row"><input id="wait-email" type="email" placeholder="you@example.com"><button type="button" id="wait-btn">Notify me</button></div></div>
  </section>

  <section class="card" id="s-plan" hidden><h2><span>2</span> Pick a plan</h2>
    <label class="choice"><input type="radio" name="plan" value="moving" checked> <span><b>Moving:</b> <span id="p-moving"></span></span></label>
    <label class="choice"><input type="radio" name="plan" value="storage"> <span><b>Storage:</b> <span id="p-storage"></span></span></label>
    <div id="addon-wrap" hidden>
      <label id="addon-pick">Need more totes? <small id="addon-note"></small>
        <select id="addons"><option value="0">No extra totes</option></select></label>
      <p id="addon-none" class="muted" hidden>Need more totes? Extra totes aren't available online right now.
        <a href="/#contact" target="_blank" rel="noopener">Contact us</a> and we may be able to add some.</p>
    </div>
    <p class="muted" id="p-deposit"></p>
  </section>

  <section class="card" id="s-date" hidden><h2><span>3</span> <span id="date-title">Pick your delivery day</span></h2>
    <p class="muted" id="date-note">We drop off first thing in the morning. Keep the totes as long as you need.</p>
    <div id="cal"></div><p id="date-msg" class="msg"></p>
    <label id="est-wrap" hidden>When do you think you'll be done? <small>(optional estimate, you can change it later)</small>
      <input id="est" type="date"></label>
  </section>

  <section class="card" id="s-info" hidden><h2><span>4</span> Your details</h2>
    <label>Name <input id="name" maxlength="100" autocomplete="name" required></label>
    <label>Phone <input id="phone" type="tel" maxlength="30" autocomplete="tel" required></label>
    <label>Email <input id="email" type="email" maxlength="200" autocomplete="email" required></label>
    <label><span id="addr-label">Delivery address</span> <input id="address" maxlength="200" autocomplete="street-address" required></label>
    <label>Notes for the driver <small>(optional: gate code, where to leave the kit)</small> <textarea id="notes" maxlength="1000"></textarea></label>
  </section>

  <section class="card" id="s-sign" hidden><h2><span>5</span> Rental agreement</h2>
    <div class="agreement" tabindex="0">${esc(agreement).replace(/\n/g, "<br>")}</div>
    <p class="muted">Replacement charges for missing or damaged items: <a href="/prices" target="_blank" rel="noopener">see the price list</a>.</p>
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
const st = { zip: "", fee: 0, zoneFee: 0, served: false, ful: "", plan: "moving", date: "", dates: [], addon: null };
const show = (id) => { $(id).hidden = false; };
const msg = (id, t, err) => { const e = $(id); e.textContent = t || ""; e.className = "msg" + (err ? " err" : ""); };

if (C.done) { $("done").hidden = false; $("f").hidden = true; return; }
$("p-moving").textContent = money(C.movingFirst) + " for the first 2 weeks (2-week minimum), then " + money(C.movingWeekly) + "/week";
$("p-deposit").textContent = "Plus a " + money(C.deposit) + " refundable deposit at booking" + (C.depositPerPack ? " (" + money(C.depositPerPack) + " more per extra tote pack)" : "") + ", refunded at pickup after a quick check of the equipment.";
$("p-storage").textContent = money(C.storageMonthly) + "/month, 1-month minimum (after that, unused full weeks are refunded after pickup)";

$("zip").addEventListener("input", async (e) => {
  const z = e.target.value.replace(/\D/g, "").slice(0, 5); e.target.value = z;
  $("wait").hidden = true; $("ful").hidden = true; msg("zip-msg", "");
  if (z.length !== 5) return;
  const r = await fetch(api("zip", "zip=" + z)).then((r) => r.json()).catch(() => ({}));
  if (!r.ok) return msg("zip-msg", r.msg || "Something went wrong.", true);
  st.zip = z; st.served = r.served; st.zoneFee = r.served ? r.fee_cents : 0;
  $("ful").hidden = false;
  const del = document.querySelector("input[name=ful][value=delivery]"), self = document.querySelector("input[name=ful][value=self]");
  del.disabled = !r.served; $("ful-del-wrap").classList.toggle("off", !r.served);
  $("ful-del-note").textContent = r.served ? (r.fee_cents ? "(delivery fee " + money(r.fee_cents) + ")" : "(free delivery)") : "(not available in " + z + " yet)";
  if (!r.served) { $("wait").hidden = false; if (self) self.checked = true; else { $("ful").hidden = true; return; } } else if (!self || !self.checked) del.checked = true;
  setFul();
});
function setFul() {
  const v = document.querySelector("input[name=ful]:checked"); if (!v) return;
  st.ful = v.value; st.fee = st.ful === "delivery" ? st.zoneFee : 0;
  $("addr-label").textContent = st.ful === "self" ? "Your address" : "Delivery address";
  $("date-title").textContent = st.ful === "self" ? "Pick the day you'll get the kit" : "Pick your delivery day";
  $("hub-wrap").hidden = st.ful !== "self" || $("hub").options.length < 2;
  $("date-note").textContent = st.ful === "self" ? "You'll get the hub address and hours in your confirmation email. Keep the totes as long as you need." : "We drop off first thing in the morning. Keep the totes as long as you need.";
  show("s-plan"); show("s-date"); if (!st.addon) { loadAddons().then(loadDates); } else if (!st.dates.length) loadDates(); summary();
}
document.querySelectorAll("input[name=ful]").forEach((r) => r.addEventListener("change", setFul));
$("wait-btn").addEventListener("click", async () => {
  const r = await fetch("/api/book/waitlist", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: $("wait-email").value, zip: $("zip").value }) }).then((r) => r.json()).catch(() => ({}));
  $("wait").innerHTML = "<p>" + (r.msg || "Something went wrong.") + "</p>";
});
document.querySelectorAll("input[name=plan]").forEach((r) => r.addEventListener("change", async () => { st.plan = r.value; st.date = ""; await loadAddons(); loadDates(); summary(); }));

async function loadDates() {
  $("cal").innerHTML = "<p class='muted'>Loading available days...</p>";
  const r = await fetch(api("dates", "plan=" + st.plan + "&addons=" + (Number($("addons").value) || 0))).then((r) => r.json()).catch(() => ({}));
  if (!r.ok) { $("cal").innerHTML = ""; return msg("date-msg", r.msg || "Couldn't load dates.", true); }
  st.dates = r.dates; st.first = r.first; st.last = r.last;
  const startFrom = st.date || r.dates[0] || r.first; st.month = startFrom.slice(0, 7);
  renderCal(r.first, r.last);
  if (st.date && !r.dates.includes(st.date)) { st.date = ""; summary(); }
  if (!r.dates.length) msg("date-msg", Number($("addons").value) ? "No open days with that many extra totes. Try fewer extra totes." : "Sorry, every kit is booked right now. Please check back soon.", true);
  else if (!st.date) msg("date-msg", "");
}
// One month at a time, with arrows; only days a kit is free are clickable.
function shiftMonth(ym, n) { const d = new Date(ym + "-01T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 7); }
function renderCal(first, last) {
  const avail = new Set(st.dates), ym = st.month, firstM = first.slice(0, 7), lastM = last.slice(0, 7);
  const m0 = new Date(ym + "-01T12:00:00Z"), title = m0.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const freeThisMonth = st.dates.filter((d) => d.startsWith(ym)).length;
  let html = "<div class='calnav'><button type='button' id='cal-prev'" + (ym <= firstM ? " disabled" : "") + " aria-label='Previous month'>&#8249;</button>" +
    "<b>" + title + "</b><button type='button' id='cal-next'" + (ym >= lastM ? " disabled" : "") + " aria-label='Next month'>&#8250;</button></div>" +
    "<div class='cal'>" + ["S","M","T","W","T","F","S"].map((d) => "<b>" + d + "</b>").join("");
  for (let i = 0; i < m0.getUTCDay(); i++) html += "<span></span>";
  for (let d = new Date(m0); d.toISOString().slice(0, 7) === ym; d.setUTCDate(d.getUTCDate() + 1)) {
    const ymd = d.toISOString().slice(0, 10);
    html += avail.has(ymd) ? "<button type='button' data-d='" + ymd + "' class='" + (ymd === st.date ? "sel" : "") + "'>" + d.getUTCDate() + "</button>"
      : "<span class='" + (ymd < first || ymd > last ? "past" : "off") + "'>" + d.getUTCDate() + "</span>";
  }
  html += "</div>" + (freeThisMonth ? "" : "<p class='muted'>No open days this month. Try the next one.</p>");
  $("cal").innerHTML = html;
  $("cal-prev").addEventListener("click", () => { st.month = shiftMonth(st.month, -1); renderCal(first, last); });
  $("cal-next").addEventListener("click", () => { st.month = shiftMonth(st.month, 1); renderCal(first, last); });
  $("cal").querySelectorAll("button[data-d]").forEach((b) => b.addEventListener("click", () => {
    st.date = b.dataset.d; renderCal(first, last); msg("date-msg", "Delivery: " + nice(st.date) + ", first thing in the morning.");
    const nx = new Date(st.date + "T12:00:00Z"); nx.setUTCDate(nx.getUTCDate() + 1);
    $("est").min = nx.toISOString().slice(0, 10); if ($("est").value && $("est").value < $("est").min) $("est").value = "";
    $("est-wrap").hidden = false;
    show("s-info"); show("s-sign"); show("s-pay"); summary();
  }));
}
async function loadAddons() {
  const r = await fetch(api("addons", "plan=" + st.plan)).then((r) => r.json()).catch(() => ({}));
  if (!r.ok) return;
  st.addon = r; const sel = $("addons"), keep = Math.min(Number(sel.value) || 0, r.max);
  sel.innerHTML = "<option value='0'>No extra totes</option>" + Array.from({ length: r.max }, (_, i) => i + 1)
    .map((n) => "<option value='" + n + "'>" + (n * r.packSize) + " extra totes (" + n + " pack" + (n > 1 ? "s" : "") + ")</option>").join("");
  sel.value = String(keep);
  $("addon-note").textContent = "packs of " + r.packSize + ": " + money(r.first) + (st.plan === "moving" ? " first 2 weeks, then " + money(r.recurring) + "/week" : "/month") + " per pack";
  $("addon-wrap").hidden = false; $("addon-pick").hidden = r.max === 0; $("addon-none").hidden = r.max > 0; summary();
}
$("addons").addEventListener("change", () => { loadDates(); summary(); });
function summary() {
  if (!st.date) { $("summary").innerHTML = ""; return; }
  const moving = st.plan === "moving", packs = Number($("addons").value) || 0, a = st.addon || { first: 0, recurring: 0, packSize: 4 };
  const period = moving ? "first 2 weeks" : "first month";
  const kitFirst = moving ? C.movingFirst : C.storageMonthly, kitNext = moving ? C.movingWeekly : C.storageMonthly;
  const ren = new Date(st.date + "T12:00:00Z"); if (moving) ren.setUTCDate(ren.getUTCDate() + 14); else ren.setUTCMonth(ren.getUTCMonth() + 1);
  const renDate = ren.toISOString().slice(0, 10);
  const depKit = C.deposit, depPacks = packs * C.depositPerPack, dep = depKit + depPacks;
  const totes = packs * a.packSize;
  const line = (label, amt, note) => "<tr><td>" + label + (note ? "<br><small>" + note + "</small>" : "") + "</td><td class='amt'>" + money(amt) + "</td></tr>";
  const rows = [
    line("Kit rental, " + period, kitFirst, moving ? "2-week minimum" : "1-month minimum"),
    packs ? line(totes + " extra totes, " + period, packs * a.first) : "",
    st.fee ? line("Delivery", st.fee) : "",
    line("Refundable deposit", dep, (depPacks ? money(depKit) + " kit + " + money(depPacks) + " extra totes. " : "") + "You get this back at pickup after a quick check."),
  ].join("");
  const nextAmt = kitNext + packs * a.recurring;
  $("summary").innerHTML =
    "<h3 class='sumh'>Due today</h3><table class='bill'>" + rows +
    "<tr class='total'><td>Total today</td><td class='amt'>" + money(dep + kitFirst + packs * a.first + st.fee) + "</td></tr></table>" +
    "<h3 class='sumh'>Only if you keep it longer</h3>" +
    "<p>Starting " + nice(renDate) + ": <b>" + money(nextAmt) + (moving ? " per week" : " per month") + "</b>" +
    (packs ? " <small>(" + money(kitNext) + " kit + " + money(packs * a.recurring) + " extra totes)</small>" : "") +
    ", charged automatically until " + (st.ful === "self" ? "you return it" : "we pick it up") + ".</p>" +
    "<h3 class='sumh'>Good to know</h3><ul class='sum'>" +
    "<li>Your rental time starts " + (st.ful === "self" ? "when you pick up the kit on " : "when we deliver on ") + nice(st.date) + ".</li>" +
    "<li>" + (moving ? "Partial weeks aren't refunded." : "After the first month, unused full weeks of your last month are refunded.") + "</li>" +
    "<li>Changed your mind? " + C.cancelText + "</li></ul>";
}
function form() {
  return { zip: st.zip, fulfillment: st.ful, hub: $("hub").value, addons: Number($("addons").value) || 0, plan: st.plan, date: st.date, est_return: $("est").value, name: $("name").value, phone: $("phone").value, email: $("email").value,
    address: $("address").value, notes: $("notes").value, agree: $("agree").checked, signed_name: $("signed").value };
}
function check() {
  const v = form();
  if (!st.ful) return "Choose delivery or pickup.";
  if (!v.date) return "Pick a day.";
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
      if (!r.ok) { msg("pay-msg", r.msg || "Something went wrong.", true); if (r.refresh) loadDates(); if (r.refreshAddons) { loadAddons(); loadDates(); } throw new Error("start failed"); }
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
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@font-face{font-family:"Permanent Marker";src:url("/fonts/PermanentMarker-Regular.ttf") format("truetype");font-display:swap}
.marker{font-family:"Permanent Marker",cursive;font-weight:400}
main.narrow{max-width:640px;margin:0 auto;padding:24px 16px 64px}main.center{text-align:center;padding-top:15vh}
.logo{width:min(220px,60vw);height:auto}.logo.small{width:110px}.home{display:inline-block}
h1{font-size:clamp(1.8rem,6vw,2.4rem);margin:.3em 0}.lede{color:var(--muted)}
.banner{background:var(--yellow);text-align:center;padding:6px 12px;font-size:.9rem;font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-top:16px}
.card.ok{border-color:var(--green)}.card h2{font-size:1.15rem;margin:0 0 10px;display:flex;align-items:center;gap:10px}
.card h2 > span:first-child{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--yellow);font-size:.95rem}
label{display:grid;gap:4px;margin:10px 0;font-size:.95rem}label.choice{display:flex;gap:10px;align-items:baseline;cursor:pointer}
input:not([type=radio]):not([type=checkbox]),textarea,select{font:inherit;padding:10px 12px;border:1px solid #bbb;border-radius:8px;width:100%;background:#fff}
textarea{min-height:80px}button{font:inherit;font-weight:600;padding:10px 16px;border:0;border-radius:8px;background:var(--yellow);color:var(--ink);cursor:pointer}
.row{display:flex;gap:8px}label.off{opacity:.5}.muted,small{color:var(--muted)}.msg{min-height:1.2em;margin:6px 0 0}.msg.err{color:var(--red)}
.calnav{display:flex;align-items:center;justify-content:space-between;margin:4px 0 8px}.calnav b{font-size:1.05rem}
.calnav button{width:40px;height:36px;padding:0;font-size:1.4rem;line-height:1;background:#fff;border:1.5px solid var(--ink)}.calnav button:disabled{opacity:.25;cursor:default}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center}.cal b{font-size:.8rem;color:var(--muted)}
.cal i{grid-column:1/-1;text-align:left;font-style:normal;font-weight:700;margin-top:8px}
.cal button,.cal span{padding:9px 0;border-radius:8px}.cal button{background:#fff;border:1.5px solid var(--ink)}.cal button:hover{background:#fff4bf}
.cal button.sel{background:var(--yellow)}.cal span.off{color:#bbb;text-decoration:line-through}.cal span.past{color:#ddd}
.agreement{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:12px;font-size:.9rem;background:#fcfcfa}
ul.sum{padding-left:20px;margin:6px 0}.sumh{font-size:.95rem;margin:16px 0 6px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}.sumh:first-child{margin-top:4px}table.bill{width:100%;border-collapse:collapse}table.bill td{padding:8px 0;border-bottom:1px solid var(--line);vertical-align:top}table.bill td.amt{text-align:right;white-space:nowrap;padding-left:12px}table.bill tr.total td{border-bottom:0;border-top:2px solid var(--ink);font-weight:700;font-size:1.1rem}#paypal{margin-top:12px}
.big{font-size:1.15rem}.prices .pi{padding:12px 0;border-bottom:1px solid var(--line)}.prices .pi:last-child{border-bottom:0}.pi-top{display:flex;justify-content:space-between;gap:16px;align-items:baseline}.pi-price{white-space:nowrap;font-weight:600}.pi-price small{font-weight:400}.pi-note{margin:4px 0 0;font-size:.88rem;color:var(--muted)}.center-text{text-align:center;margin-top:24px}.row input{flex:1}
button.link{background:none;padding:0;color:#0b57d0;text-decoration:underline;font-weight:400}
`;
