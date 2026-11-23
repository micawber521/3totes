// /admin: server-rendered pages for Christian (owner) and drivers.
// Step 1 of BOOKING_DESIGN: kits, manual bookings, schedule, settings. No payments yet.
import { adminIdentity } from "./access.js";
import { ensureSchema, getSettings, kitConflict, newToken, addonPacksAvailable, ADDON_PACK_SIZE, HUBS, hubName, allHubs } from "./db.js";
import { paypalReady, refundSale, cancelSubscription } from "./paypal.js";
import { trySend } from "./mail.js";
import { cancelFee, cancelBooking } from "./cancel.js";

const TZ = "America/Chicago";
const STATUSES = ["pending", "confirmed", "delivered", "pickup_requested", "returned", "closed", "cancelled"];
const STATUS_LABEL = {
  pending: "Pending", confirmed: "Confirmed", delivered: "Delivered", pickup_requested: "Pickup requested",
  returned: "Returned", closed: "Closed", cancelled: "Cancelled",
};
const KIT_STATUSES = ["active", "cleaning", "retired"];
const KIT_TOTES = 12; // totes in a kit; a split kit adds all of them to the extra-tote pool
// charge for one price-list line: package items are replaced by the whole pack.
const lineCharge = (it, qty) => qty > 0 ? Math.ceil(qty / Math.max(1, it.pack_size)) * it.price_cents : 0;
const packNote = (it) => it.pack_size > 1 ? `pack of ${it.pack_size}: any missing = whole pack` : "";
const SETTING_FIELDS = [
  ["deposit_cents", "Deposit", "money"],
  ["deposit_per_pack_cents", "Deposit added per extra tote pack", "money"],
  ["moving_first_cents", "Moving plan, first 2 weeks", "money"],
  ["moving_weekly_cents", "Moving plan, each week after", "money"],
  ["storage_monthly_cents", "Storage plan, monthly", "money"],
  ["buffer_days", "Turnaround days between rentals", "int"],
  ["lead_days", "Days of notice before a delivery (online)", "int"],
  ["booking_horizon_days", "How far ahead customers can book (days)", "count"],
  ["spare_totes", "Spare totes on hand (for extra-tote packs)", "count"],
  ["addon_moving_first_cents", "Extra totes (pack of 4), moving: first 2 weeks", "money"],
  ["addon_moving_weekly_cents", "Extra totes (pack of 4), moving: each week after", "money"],
  ["addon_storage_monthly_cents", "Extra totes (pack of 4), storage: monthly", "money"],
  ["pickup_location_text", "Extra hub pickup/drop-off instructions (optional)", "longtext"],
  ["cancel_fee_early_cents", "Cancellation fee, early", "money"],
  ["cancel_fee_late_cents", "Cancellation fee, late", "money"],
  ["cancel_cutoff_days", "Early = at least this many days before delivery", "int"],
  ["agreement_version", "Rental agreement version", "text"],
];

// ---------- helpers ----------

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (cents) => "$" + (Number(cents || 0) / 100).toFixed(2);
const toCents = (s) => { const n = Number(String(s).replace(/[$,\s]/g, "")); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z"));
const niceDate = (ymd) => ymd ? new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
const badge = (s) => `<span class="badge s-${esc(s)}">${esc(STATUS_LABEL[s] || s)}</span>`;

function page(title, who, body, flash = "") {
  const nav = who.role === "owner"
    ? `<a href="/admin">Schedule</a><a href="/admin/bookings">Bookings</a><a href="/admin/bookings/new">New booking</a><a href="/admin/kits">Kits</a><a href="/admin/zones">Zones</a><a href="/admin/prices">Price list</a><a href="/admin/settings">Settings</a>`
    : `<a href="/admin">Schedule</a>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)} · 3totes admin</title><style>${CSS}</style></head><body>
<header><a class="brand" href="/admin">3totes admin</a><nav>${nav}</nav><span class="who">${esc(who.email)}</span></header>
<main>${flash ? `<p class="flash">${esc(flash)}</p>` : ""}<h1>${esc(title)}</h1>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
}

const redirect = (to) => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store" } });
const deny = (status, msg) => new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

async function logEvent(db, bookingId, who, action, detail = "") {
  await db.prepare("INSERT INTO booking_events (booking_id, by_email, action, detail) VALUES (?, ?, ?, ?)")
    .bind(bookingId, who.email, action, detail).run();
}

// ---------- router ----------

export async function handleAdmin(request, env) {
  const who = await adminIdentity(request, env);
  if (who.error) {
    console.warn("admin denied:", who.error);
    return deny(who.error === "not-configured" ? 503 : 403, who.error === "not-configured" ? "Admin is not configured yet." : "Forbidden");
  }
  if (!env.DB) return deny(503, "Database is not connected yet.");

  const url = new URL(request.url);
  if (request.method === "POST" && request.headers.get("Origin") !== url.origin) return deny(403, "Forbidden");

  const db = env.DB;
  await ensureSchema(db);

  const path = url.pathname.replace(/\/+$/, "") || "/admin";
  const flash = url.searchParams.get("msg") || "";
  const m = path.match(/^\/admin\/bookings\/(\d+)$/);

  if (path === "/admin" && request.method === "GET") return schedule(db, who, flash);
  if (who.role !== "owner") return deny(403, "Forbidden");

  if (path === "/admin/bookings" && request.method === "GET") return bookingList(db, who, url, flash);
  if (path === "/admin/bookings/new" && request.method === "GET") return bookingForm(db, who, {}, "");
  if (path === "/admin/bookings/new" && request.method === "POST") return bookingCreate(db, who, request);
  if (m && request.method === "GET") return bookingView(db, who, Number(m[1]), flash);
  if (m && request.method === "POST") return bookingUpdate(db, who, Number(m[1]), request, env);
  if (path === "/admin/kits") return request.method === "POST" ? kitsPost(db, request) : kitsPage(db, who, flash);
  if (path === "/admin/settings") return request.method === "POST" ? settingsPost(db, request) : settingsPage(db, who, flash, url, env);
  if (path === "/admin/prices") return request.method === "POST" ? pricesPost(db, request) : pricesPage(db, who, flash);
  if (path === "/admin/zones") return request.method === "POST" ? zonesPost(db, request) : zonesPage(db, who, flash);
  return deny(404, "Not found");
}

// ---------- schedule (owner + driver) ----------

async function schedule(db, who, flash) {
  const t = today(), horizon = addDays(t, 14);
  const drops = (await db.prepare(
    `SELECT b.*, c.name, c.phone, k.label AS kit FROM bookings b
       JOIN customers c ON c.id = b.customer_id JOIN kits k ON k.id = b.kit_id
      WHERE b.status IN ('pending','confirmed') AND b.delivery_date <= ?
      ORDER BY b.delivery_date, b.id`).bind(horizon).all()).results;
  const pickups = (await db.prepare(
    `SELECT b.*, c.name, c.phone, k.label AS kit FROM bookings b
       JOIN customers c ON c.id = b.customer_id JOIN kits k ON k.id = b.kit_id
      WHERE b.status IN ('delivered','pickup_requested')
        AND (b.status = 'pickup_requested' OR (b.pickup_date IS NOT NULL AND b.pickup_date <= ?))
      ORDER BY b.pickup_date IS NULL, b.pickup_date, b.id`).bind(horizon).all()).results;
  const out = (await db.prepare(
    `SELECT b.id, b.delivery_date, b.pickup_date, b.est_return_date, c.name, k.label AS kit FROM bookings b
       JOIN customers c ON c.id = b.customer_id JOIN kits k ON k.id = b.kit_id
      WHERE b.status IN ('delivered','pickup_requested') ORDER BY b.delivery_date`).all()).results;

  const isOwner = who.role === "owner";
  const stop = (b, date, kind) => {
    const late = date && date < t;
    const name = isOwner ? `<a href="/admin/bookings/${b.id}">${esc(b.name)}</a>` : esc(b.name);
    const atUs = (kind === "drop" && b.fulfillment === "self") || (kind === "pick" && b.return_method === "dropoff");
    const addr = kind === "pick" && b.pickup_address ? b.pickup_address : b.address, zip = kind === "pick" && b.pickup_zip ? b.pickup_zip : b.zip;
    const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr + " " + zip)}`;
    return `<tr class="${late ? "late" : date === t ? "today" : ""}">
      <td>${date ? esc(niceDate(date)) : "<em>no date</em>"}${late ? " <b>overdue</b>" : ""}</td>
      <td>${name}<br><small>${esc(b.phone || "")}</small></td>
      <td>${atUs ? `<b>${kind === "drop" ? `Customer picks up at ${esc(hubName(b.hub))} hub` : `Customer drops off at ${esc(hubName(b.hub))} hub`}</b>` : `<a href="${esc(map)}" target="_blank" rel="noopener">${esc(addr)}, ${esc(zip)}</a>${kind === "pick" && b.pickup_address ? " <small>(new address)</small>" : ""}`}${b.addon_packs ? `<br><small>+${b.addon_packs * ADDON_PACK_SIZE} extra totes</small>` : ""}${b.notes ? `<br><small>${esc(b.notes)}</small>` : ""}</td>
      <td>${esc(b.kit)}</td><td>${badge(b.status)}</td></tr>`;
  };
  const table = (rows, kind, empty) => rows.length
    ? `<table><thead><tr><th>Date</th><th>Customer</th><th>Address</th><th>Kit</th><th>Status</th></tr></thead><tbody>${rows.map((b) => stop(b, kind === "drop" ? b.delivery_date : b.pickup_date, kind)).join("")}</tbody></table>`
    : `<p class="muted">${empty}</p>`;

  return page("Schedule", who, `
    <p class="muted">Today is ${esc(niceDate(t))}. Drop-offs happen first thing in the morning on the delivery date. Showing the next 14 days.</p>
    <h2>Drop-offs</h2>${table(drops, "drop", "No drop-offs in the next 14 days.")}
    <h2>Pickups <small class="muted">(empty totes only)</small></h2>${table(pickups, "pick", "No pickups scheduled in the next 14 days.")}
    <h2>Out now</h2>${out.length
      ? `<ul>${out.map((b) => `<li>${esc(b.kit)}: ${isOwner ? `<a href="/admin/bookings/${b.id}">${esc(b.name)}</a>` : esc(b.name)} since ${esc(niceDate(b.delivery_date))}${b.pickup_date ? `, pickup ${esc(niceDate(b.pickup_date))}` : b.est_return_date ? `, customer estimate ~${esc(niceDate(b.est_return_date))}` : ", open-ended"}</li>`).join("")}</ul>`
      : `<p class="muted">Nothing out right now.</p>`}`, flash);
}

// ---------- bookings ----------

async function bookingList(db, who, url, flash) {
  const status = url.searchParams.get("status") || "";
  const q = (url.searchParams.get("q") || "").trim();
  const where = [], args = [];
  if (STATUSES.includes(status)) { where.push("b.status = ?"); args.push(status); }
  if (q) { where.push("(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR b.address LIKE ?)"); args.push(...Array(4).fill(`%${q}%`)); }
  const rows = (await db.prepare(
    `SELECT b.id, b.status, b.plan, b.delivery_date, b.pickup_date, b.address, c.name, k.label AS kit
       FROM bookings b JOIN customers c ON c.id = b.customer_id JOIN kits k ON k.id = b.kit_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY b.delivery_date DESC, b.id DESC LIMIT 200`).bind(...args).all()).results;
  const opts = ["", ...STATUSES].map((s) => `<option value="${s}"${s === status ? " selected" : ""}>${s ? esc(STATUS_LABEL[s]) : "All statuses"}</option>`).join("");
  return page("Bookings", who, `
    <form class="filters" method="get"><input name="q" value="${esc(q)}" placeholder="Name, phone, email, address"><select name="status">${opts}</select><button>Filter</button>
      <a class="button" href="/admin/bookings/new">+ New booking</a></form>
    ${rows.length ? `<table><thead><tr><th>#</th><th>Customer</th><th>Plan</th><th>Delivery</th><th>Pickup</th><th>Kit</th><th>Status</th></tr></thead><tbody>
      ${rows.map((b) => `<tr><td><a href="/admin/bookings/${b.id}">${b.id}</a></td><td><a href="/admin/bookings/${b.id}">${esc(b.name)}</a><br><small>${esc(b.address)}</small></td>
        <td>${esc(b.plan)}</td><td>${esc(niceDate(b.delivery_date))}</td><td>${b.pickup_date ? esc(niceDate(b.pickup_date)) : "<em>open</em>"}</td><td>${esc(b.kit)}</td><td>${badge(b.status)}</td></tr>`).join("")}
      </tbody></table>` : `<p class="muted">No bookings found.</p>`}`, flash);
}

async function bookingForm(db, who, v, error) {
  const s = await getSettings(db);
  const kits = (await db.prepare("SELECT id, label, status FROM kits WHERE status != 'retired' ORDER BY label").all()).results;
  const plan = v.plan || "moving";
  return page("New booking", who, `
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <form method="post" class="grid">
      <fieldset><legend>Customer</legend>
        <label>Name <input name="name" required maxlength="100" value="${esc(v.name)}"></label>
        <label>Phone <input name="phone" type="tel" maxlength="30" value="${esc(v.phone)}"></label>
        <label>Email <input name="email" type="email" maxlength="200" value="${esc(v.email)}"></label>
      </fieldset>
      <fieldset><legend>Delivery</legend>
        <label>Address <input name="address" required maxlength="200" value="${esc(v.address)}"></label>
        <label>Zip <input name="zip" required pattern="\\d{5}" maxlength="5" value="${esc(v.zip)}"></label>
        <label>Delivery date <small>(drop-off first thing that morning)</small> <input name="delivery_date" type="date" required value="${esc(v.delivery_date)}"></label>
        <label>Pickup date <small>(blank = open-ended)</small> <input name="pickup_date" type="date" value="${esc(v.pickup_date)}"></label>
        <label>Customer's estimated return <small>(info only)</small> <input name="est_return_date" type="date" value="${esc(v.est_return_date)}"></label>
      </fieldset>
      <fieldset><legend>Rental</legend>
        <label>Plan <select name="plan">
          <option value="moving"${plan === "moving" ? " selected" : ""}>Moving: ${money(s.moving_first_cents)} first 2 weeks, then ${money(s.moving_weekly_cents)}/week</option>
          <option value="storage"${plan === "storage" ? " selected" : ""}>Storage: ${money(s.storage_monthly_cents)}/month</option></select></label>
        <label>Handoff <select name="fulfillment"><option value="delivery">We deliver &amp; pick up</option><option value="self"${v.fulfillment === "self" ? " selected" : ""}>Customer picks up &amp; returns at a hub</option></select></label>
        <label>Hub <small>(customer pickup/return)</small> <select name="hub">${Object.entries(HUBS).map(([k, n]) => `<option value="${k}"${v.hub === k ? " selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
        <label>Extra totes <small>(packs of ${ADDON_PACK_SIZE})</small> <input name="addon_packs" type="number" min="0" max="10" value="${esc(v.addon_packs || "0")}"></label>
        <label>Kit <select name="kit_id">${kits.map((k) => `<option value="${k.id}"${String(k.id) === String(v.kit_id) ? " selected" : ""}>${esc(k.label)}${k.status === "cleaning" ? " (cleaning)" : ""}</option>`).join("")}</select></label>
        <label>Deposit <small>(base; ${money(s.deposit_per_pack_cents)} per extra tote pack is added automatically)</small> <input name="deposit" inputmode="decimal" value="${esc(v.deposit ?? (Number(s.deposit_cents || 0) / 100).toFixed(2))}"></label>
        <label>Status <select name="status"><option value="confirmed">Confirmed</option><option value="pending"${v.status === "pending" ? " selected" : ""}>Pending</option></select></label>
        <label>Notes <textarea name="notes" maxlength="2000" placeholder="Gate code, stairs, where to leave the kit...">${esc(v.notes)}</textarea></label>
      </fieldset>
      <button type="submit">Create booking</button>
    </form>`);
}

async function readForm(request) {
  const f = await request.formData();
  const v = {};
  for (const [k, val] of f.entries()) v[k] = String(val).trim();
  return v;
}

async function bookingCreate(db, who, request) {
  const v = await readForm(request);
  const s = await getSettings(db);
  const fail = (msg) => bookingForm(db, who, v, msg);

  if (!v.name || !v.address || !v.zip) return fail("Name, address and zip are required.");
  if (!/^\d{5}$/.test(v.zip)) return fail("Zip must be 5 digits.");
  if (!["moving", "storage"].includes(v.plan)) return fail("Pick a plan.");
  if (!isDate(v.delivery_date)) return fail("Pick a delivery date.");
  if (v.pickup_date && !isDate(v.pickup_date)) return fail("Pickup date is not a valid date.");
  if (v.pickup_date && v.pickup_date < v.delivery_date) return fail("Pickup date is before the delivery date.");
  if (v.est_return_date && (!isDate(v.est_return_date) || v.est_return_date <= v.delivery_date)) return fail("Estimated return must be after the delivery date.");
  const deposit = toCents(v.deposit || "0");
  if (deposit === null) return fail("Deposit must be a dollar amount.");
  const kit = await db.prepare("SELECT id, label, status FROM kits WHERE id = ?").bind(Number(v.kit_id)).first();
  if (!kit || kit.status === "retired") return fail("Pick a kit.");
  const short = await db.prepare("SELECT totes_borrowed FROM kits WHERE id = ?").bind(kit.id).first();
  if (short && short.totes_borrowed) return fail(`${kit.label} is split for extra totes. Pick another kit, or uncheck Split on the Kits page.`);
  const packs = Number(v.addon_packs || 0);
  if (!Number.isInteger(packs) || packs < 0 || packs > 10) return fail("Extra tote packs must be 0-10.");
  if (packs && packs > await addonPacksAvailable(db, s, v.delivery_date, v.pickup_date || null)) return fail("Not enough spare totes for those dates (check Spare totes in Settings).");
  const self = v.fulfillment === "self";
  const depositTotal = deposit + packs * (Number(s.deposit_per_pack_cents) || 0);

  const clash = await kitConflict(db, { kitId: kit.id, start: v.delivery_date, end: v.pickup_date || null, bufferDays: s.buffer_days });
  if (clash) return fail(`${kit.label} is already booked by ${clash.name} (#${clash.id}) from ${niceDate(clash.delivery_date)}${clash.pickup_date ? ` to ${niceDate(clash.pickup_date)}` : " (open-ended)"}, plus ${s.buffer_days} turnaround day(s).`);

  let customer = v.email ? await db.prepare("SELECT id FROM customers WHERE lower(email) = lower(?)").bind(v.email).first() : null;
  if (customer) {
    await db.prepare("UPDATE customers SET name = ?, phone = COALESCE(NULLIF(?, ''), phone) WHERE id = ?").bind(v.name, v.phone, customer.id).run();
  } else {
    customer = await db.prepare("INSERT INTO customers (name, email, phone) VALUES (?, NULLIF(?, ''), NULLIF(?, '')) RETURNING id")
      .bind(v.name, v.email, v.phone).first();
  }
  const status = v.status === "pending" ? "pending" : "confirmed";
  const b = await db.prepare(
    `INSERT INTO bookings (customer_id, kit_id, plan, status, address, zip, delivery_date, pickup_date, notes, deposit_cents, agreement_version, source,
       est_return_date, manage_token, fulfillment, addon_packs, return_method, hub)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, 'admin', NULLIF(?, ''), ?, ?, ?, ?, ?) RETURNING id`)
    .bind(customer.id, kit.id, v.plan, status, v.address, v.zip, v.delivery_date, v.pickup_date || "", v.notes || "", depositTotal, s.agreement_version || null,
      v.est_return_date || "", newToken(), self ? "self" : "delivery", packs, self ? "dropoff" : "pickup", self ? (HUBS[v.hub] ? v.hub : Object.keys(HUBS)[0] || null) : null).first();
  await logEvent(db, b.id, who, "created", `${v.plan}, ${kit.label}, delivery ${v.delivery_date}`);
  return redirect(`/admin/bookings/${b.id}?msg=${encodeURIComponent("Booking created.")}`);
}

async function bookingView(db, who, id, flash, error = "") {
  const b = await db.prepare(
    `SELECT b.*, c.name, c.email, c.phone, k.label AS kit FROM bookings b
       JOIN customers c ON c.id = b.customer_id JOIN kits k ON k.id = b.kit_id WHERE b.id = ?`).bind(id).first();
  if (!b) return deny(404, "Not found");
  const events = (await db.prepare("SELECT * FROM booking_events WHERE booking_id = ? ORDER BY id DESC").bind(id).all()).results;
  const kits = (await db.prepare("SELECT id, label FROM kits WHERE status != 'retired' OR id = ? ORDER BY label").bind(b.kit_id).all()).results;
  const pays = (await db.prepare("SELECT * FROM payments WHERE booking_id = ? ORDER BY id").bind(id).all()).results;
  const setup = pays.find((p) => p.kind === "setup");
  const refundLeft = b.deposit_cents - b.deposit_refunded_cents;
  const billingOn = b.paypal_subscription_id && !["CANCELLED", "EXPIRED"].includes(b.billing_status || "");
  const online = b.source === "online";
  const rr = rentalRefundInfo(b, pays);
  const t = today();
  const sAll = await getSettings(db);
  const rrToday = rentalRefundInfo({ ...b, pickup_date: t }, pays);
  const canComplete = ["delivered", "pickup_requested"].includes(b.status);
  const priceItems = canComplete ? (await db.prepare("SELECT * FROM price_items WHERE active = 1 ORDER BY sort, name").all()).results : [];
  const handling = priceItems.find((i) => i.kind === "handling");
  const complete = canComplete ? `<section class="card complete"><h2>Complete pickup</h2>
      <p class="muted">Do this onsite once everything is loaded. It marks the kit returned${b.paypal_subscription_id ? ", stops PayPal billing" : ""} and refunds the deposit.</p>
      <form method="post" class="grid narrow" onsubmit="return confirm('Complete pickup and issue the refund now?')">
        <input type="hidden" name="action" value="complete_pickup">
        <fieldset><legend>Count everything. Enter only what's missing or damaged.</legend>
          ${priceItems.filter((i) => i.kind === "item").map((i) => `<label class="qty"><span>${esc(i.name)} <small>${i.kit_qty ? `kit has ${i.kit_qty}${i.key === "tote" && b.addon_packs ? ` + ${b.addon_packs * ADDON_PACK_SIZE} extra` : ""}` : ""}${packNote(i) ? ` · ${esc(packNote(i))}` : ""} · ${money(i.price_cents)}${i.pack_size > 1 ? "/pack" : ""}</small></span>
            <input name="q_${esc(i.key)}" type="number" min="0" max="${(i.kit_qty || 99) + (i.key === "tote" ? b.addon_packs * ADDON_PACK_SIZE : 0)}" value="0" inputmode="numeric"></label>`).join("")}
          ${priceItems.filter((i) => i.kind === "cleaning").map((i) => `<label class="check"><input type="checkbox" name="q_${esc(i.key)}" value="1"> ${esc(i.name)}: ${money(i.price_cents)}</label>`).join("")}
          ${handling ? `<small class="muted">${esc(handling.name)} (${money(handling.price_cents)}) is added automatically if anything has to be replaced.</small>` : ""}
        </fieldset>
        <label>Other charge <small>(optional)</small> <input name="extra" inputmode="decimal" value="0.00"></label>
        <label>Other charge reason <small>(required with an other charge; the customer sees it)</small> <input name="extra_reason" maxlength="200"></label>
        ${b.plan === "storage" && rrToday && rrToday.suggest > 0 ? `<label class="check"><input type="checkbox" name="refund_weeks" checked> Also refund unused storage weeks: ${money(rrToday.suggest)}</label><small class="muted">${esc(rrToday.note)}</small>` : ""}
        <p>Deposit refund: <b>${money(b.deposit_cents - b.deposit_refunded_cents)}</b> minus any charges. Charges above the deposit are recorded as owed.</p>
        <button type="submit">Complete pickup &amp; refund</button>
      </form></section>` : "";
  const billing = online ? `<section class="card"><h2>PayPal</h2>
      <p>Billing: <b>${esc(b.billing_status || "unknown")}</b>${b.plan === "moving" ? ` · ${money(b.rate_first_cents)} first 2 weeks, then ${money(b.rate_recurring_cents)}/week` : ` · ${money(b.rate_recurring_cents)}/month`}
      ${b.delivery_fee_cents ? ` · delivery fee ${money(b.delivery_fee_cents)}` : ""}</p>
      ${pays.length ? `<table><thead><tr><th>When (UTC)</th><th>What</th><th>Amount</th></tr></thead><tbody>${pays.map((p) => `<tr><td>${esc(p.created_at)}</td><td>${esc({ setup: "Paid at booking", rental: "Rental renewal", refund: "Refund", other: "Other" }[p.kind])}</td><td>${p.kind === "refund" ? "−" : ""}${money(p.amount_cents)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No payments received yet.</p>`}
      ${billingOn ? `<form method="post" class="inline" onsubmit="return confirm('Stop all future PayPal billing for this booking?')"><input type="hidden" name="action" value="cancel_billing"><button>Stop billing</button> <small class="muted">Do this when the kit is picked up.</small></form>` : ""}
      ${setup && refundLeft > 0 ? `<form method="post" class="inline" onsubmit="return confirm('Refund this amount through PayPal?')"><input type="hidden" name="action" value="refund">
        <label>Refund deposit <input name="amount" inputmode="decimal" value="${(refundLeft / 100).toFixed(2)}"></label><button>Refund via PayPal</button>
        <small class="muted">Lower the amount to keep damage charges.</small></form>` : ""}
      ${rr ? `<form method="post" class="inline" onsubmit="return confirm('Refund this rental amount through PayPal?')"><input type="hidden" name="action" value="refund_rental">
        <label>Refund unused weeks <input name="amount" inputmode="decimal" value="${(rr.suggest / 100).toFixed(2)}"></label><button>Refund rental via PayPal</button>
        <small class="muted">${esc(rr.note)}</small></form>` : ""}
    </section>` : "";
  return page(`Booking #${b.id}: ${b.name}`, who, `
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <div class="cols">
      <section class="card"><h2>Details</h2><dl>
        <dt>Status</dt><dd>${badge(b.status)}</dd>
        <dt>Customer</dt><dd>${esc(b.name)}<br>${esc(b.phone || "")}${b.email ? `<br><a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : ""}</dd>
        <dt>Address</dt><dd>${esc(b.address)}, ${esc(b.zip)}</dd>
        <dt>Plan</dt><dd>${esc(b.plan)}${b.addon_packs ? ` + ${b.addon_packs * ADDON_PACK_SIZE} extra totes (${b.addon_packs} pack${b.addon_packs > 1 ? "s" : ""})` : ""}</dd>
        <dt>Handoff</dt><dd>${b.fulfillment === "self" ? `Customer picks up at ${esc(hubName(b.hub))} hub` : "We deliver"} · return: ${b.return_method === "dropoff" ? `customer drops off at ${esc(hubName(b.hub))} hub` : `we pick up${b.pickup_address ? ` at <b>${esc(b.pickup_address)}, ${esc(b.pickup_zip || "")}</b> (new address)` : ""}`}</dd>
        <dt>Kit</dt><dd>${esc(b.kit)}</dd>
        <dt>Delivery</dt><dd>${esc(niceDate(b.delivery_date))}, first thing in the morning</dd>
        <dt>Pickup</dt><dd>${b.pickup_date ? esc(niceDate(b.pickup_date)) : "Open-ended"}</dd>
        <dt>Est. return</dt><dd>${b.est_return_date ? esc(niceDate(b.est_return_date)) + " <small>(customer estimate)</small>" : "<span class='muted'>none</span>"}</dd>
        <dt>Customer link</dt><dd>${b.manage_token ? `<input readonly value="https://3totes.com/my/${esc(b.manage_token)}" onclick="this.select()"><br><small>Their page to schedule pickup. Send it to manual-booking customers.</small>` : ""}</dd>
        <dt>Deposit</dt><dd>${money(b.deposit_cents)}${b.deposit_refunded_cents ? `, refunded ${money(b.deposit_refunded_cents)}` : ""}${b.deposit_kept_cents ? `, kept ${money(b.deposit_kept_cents)} (${esc(b.deposit_kept_reason || "")})` : ""}${b.balance_owed_cents ? `<br><b class="owed">Owed beyond deposit: ${money(b.balance_owed_cents)}</b> <small>(send a PayPal invoice)</small>` : ""}</dd>
        <dt>Agreement</dt><dd>${b.signed_at ? `Signed by ${esc(b.signed_name)} at ${esc(b.signed_at)}` : `Not signed online (${esc(b.agreement_version || "no version")})`}</dd>
        <dt>Source</dt><dd>${esc(b.source)}, created ${esc(b.created_at)} UTC</dd>
      </dl></section>
      <section class="card"><h2>Update</h2>
        <form method="post" class="grid">
          <label>Status <select name="status">${STATUSES.map((s) => `<option value="${s}"${s === b.status ? " selected" : ""}>${esc(STATUS_LABEL[s])}</option>`).join("")}</select></label>
          <label>Kit <select name="kit_id">${kits.map((k) => `<option value="${k.id}"${k.id === b.kit_id ? " selected" : ""}>${esc(k.label)}</option>`).join("")}</select></label>
          <label>Delivery date <input name="delivery_date" type="date" required value="${esc(b.delivery_date)}"></label>
          <label>Pickup date <small>(blank = open-ended)</small> <input name="pickup_date" type="date" value="${esc(b.pickup_date || "")}"></label>
          <label>Customer's estimated return <input name="est_return_date" type="date" value="${esc(b.est_return_date || "")}"></label>
          <label>Deposit refunded <input name="deposit_refunded" inputmode="decimal" value="${(b.deposit_refunded_cents / 100).toFixed(2)}"></label>
          <label>Notes <textarea name="notes" maxlength="2000">${esc(b.notes || "")}</textarea></label>
          <label>Log note <small>(added to the history)</small> <input name="log" maxlength="500"></label>
          <button type="submit">Save</button>
        </form></section>
      ${complete}
      ${["pending", "confirmed"].includes(b.status) && b.paypal_subscription_id ? (() => { const c = cancelFee(sAll, b.delivery_date, t); return `<section class="card"><h2>Cancel booking</h2>
        <p class="muted">${c.days} day${c.days === 1 ? "" : "s"} before delivery → ${c.early ? "early" : "late"} fee. Refunds everything else paid at booking and stops billing.</p>
        <form method="post" class="inline" onsubmit="return confirm('Cancel this booking and refund now?')"><input type="hidden" name="action" value="cancel_booking">
          <label>Fee <input name="fee" inputmode="decimal" value="${(c.fee / 100).toFixed(2)}"></label><button>Cancel &amp; refund</button></form></section>`; })() : ""}
      ${billing}
    </div>
    <h2>History</h2>
    ${events.length ? `<ul class="events">${events.map((e) => `<li><time>${esc(e.at)} UTC</time> <b>${esc(e.action)}</b> ${esc(e.detail || "")} <small class="muted">${esc(e.by_email || "")}</small></li>`).join("")}</ul>` : `<p class="muted">No history.</p>`}`, flash);
}

async function bookingUpdate(db, who, id, request, env) {
  const b = await db.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!b) return deny(404, "Not found");
  const v = await readForm(request);
  if (v.action === "complete_pickup") return completePickup(db, who, b, v, env);
  if (v.action === "cancel_booking") {
    const back = (msg) => redirect(`/admin/bookings/${id}?msg=${encodeURIComponent(msg)}`);
    if (!["pending", "confirmed"].includes(b.status)) return back("Only bookings that haven't been delivered can be cancelled here.");
    const fee = toCents(v.fee || "0");
    if (fee === null) return back("Fee must be a dollar amount.");
    const cust = await db.prepare("SELECT name, email FROM customers WHERE id = ?").bind(b.customer_id).first();
    const r = await cancelBooking(env, db, { ...b, ...cust }, { fee, by: who.email });
    return back(r.ok ? `Cancelled. Fee ${money(fee)}, refunded ${money(r.refunded || 0)}. Customer emailed.` : r.msg);
  }
  if (["cancel_billing", "refund", "refund_rental"].includes(v.action)) return billingAction(db, who, b, v, env);
  const s = await getSettings(db);
  const fail = (msg) => bookingView(db, who, id, "", msg);

  const status = STATUSES.includes(v.status) ? v.status : b.status;
  if (!isDate(v.delivery_date)) return fail("Delivery date is not valid.");
  if (v.pickup_date && !isDate(v.pickup_date)) return fail("Pickup date is not valid.");
  if (v.pickup_date && v.pickup_date < v.delivery_date) return fail("Pickup date is before the delivery date.");
  const refunded = toCents(v.deposit_refunded || "0");
  if (refunded === null) return fail("Deposit refunded must be a dollar amount.");
  if (refunded > b.deposit_cents) return fail("Refund is more than the deposit.");
  if (v.est_return_date && !isDate(v.est_return_date)) return fail("Estimated return is not a valid date.");
  const kitId = Number(v.kit_id) || b.kit_id;

  if (status !== "cancelled") {
    const clash = await kitConflict(db, { kitId, start: v.delivery_date, end: v.pickup_date || null, bufferDays: s.buffer_days, excludeId: id });
    if (clash) return fail(`That kit is already booked by ${clash.name} (#${clash.id}) from ${niceDate(clash.delivery_date)}${clash.pickup_date ? ` to ${niceDate(clash.pickup_date)}` : " (open-ended)"}.`);
  }

  const changes = [];
  if (status !== b.status) changes.push(`status ${b.status} → ${status}`);
  if (kitId !== b.kit_id) changes.push("kit changed");
  if (v.delivery_date !== b.delivery_date) changes.push(`delivery ${b.delivery_date} → ${v.delivery_date}`);
  if ((v.pickup_date || null) !== (b.pickup_date || null)) changes.push(`pickup ${b.pickup_date || "open"} → ${v.pickup_date || "open"}`);
  if (refunded !== b.deposit_refunded_cents) changes.push(`deposit refunded ${money(refunded)}`);
  if ((v.est_return_date || null) !== (b.est_return_date || null)) changes.push(`estimate ${b.est_return_date || "none"} → ${v.est_return_date || "none"}`);
  if ((v.notes || "") !== (b.notes || "")) changes.push("notes edited");

  await db.prepare(
    `UPDATE bookings SET status = ?, kit_id = ?, delivery_date = ?, pickup_date = NULLIF(?, ''), deposit_refunded_cents = ?,
       notes = NULLIF(?, ''), est_return_date = NULLIF(?, ''), updated_at = datetime('now') WHERE id = ?`)
    .bind(status, kitId, v.delivery_date, v.pickup_date || "", refunded, v.notes || "", v.est_return_date || "", id).run();
  if (changes.length) await logEvent(db, id, who, "updated", changes.join("; "));
  if (v.log) await logEvent(db, id, who, "note", v.log);
  return redirect(`/admin/bookings/${id}?msg=${encodeURIComponent(changes.length || v.log ? "Saved." : "No changes.")}`);
}

// ---------- kits ----------

async function kitsPage(db, who, flash) {
  const t = today();
  const kits = (await db.prepare(
    `SELECT k.*, (SELECT b.id || '|' || c.name FROM bookings b JOIN customers c ON c.id = b.customer_id
                   WHERE b.kit_id = k.id AND b.status IN ('delivered','pickup_requested') LIMIT 1) AS out_with,
            (SELECT COALESCE(b.pickup_date, '~' || b.est_return_date) FROM bookings b
              WHERE b.kit_id = k.id AND b.status IN ('delivered','pickup_requested') LIMIT 1) AS back,
            (SELECT MIN(b.delivery_date) FROM bookings b
              WHERE b.kit_id = k.id AND b.status IN ('pending','confirmed') AND b.delivery_date >= ?) AS next_drop
       FROM kits k ORDER BY k.status = 'retired', k.label`).bind(t).all()).results;
  return page("Kits", who, `
    <p class="muted">Need to break up a kit for an extra-tote order? Check <b>Split for extras</b>. That kit can't be booked while it's split,
      and all ${KIT_TOTES} of its totes become extra totes (packs of ${ADDON_PACK_SIZE}). Uncheck it when the kit is whole again.</p>
    <table><thead><tr><th>Kit</th><th>Where</th><th>Next drop-off</th><th>Status</th><th>Split for extras</th><th>Notes</th><th></th></tr></thead><tbody>
    ${kits.map((k) => {
      const [bid, bname] = (k.out_with || "").split("|");
      const f = `kit-${k.id}`;
      return `<tr>
        <td><b>${esc(k.label)}</b></td>
        <td>${k.out_with ? `Out: <a href="/admin/bookings/${esc(bid)}">${esc(bname)}</a>${k.back ? `<br><small>back ${k.back.startsWith("~") ? "~" + esc(niceDate(k.back.slice(1))) + " (estimate)" : esc(niceDate(k.back))}</small>` : "<br><small>no return date</small>"}` : k.status === "retired" ? "Retired" : k.totes_borrowed ? `<b class="owed">Split for extra totes</b><br><small>not rentable</small>` : "Home"}</td>
        <td>${k.next_drop ? esc(niceDate(k.next_drop)) : "<span class='muted'>none</span>"}</td>
        <td><select name="status" form="${f}">${KIT_STATUSES.map((s) => `<option${s === k.status ? " selected" : ""}>${s}</option>`).join("")}</select></td>
        <td><input type="hidden" name="split_present" value="1" form="${f}"><label class="check"><input type="checkbox" name="split" form="${f}"${k.totes_borrowed ? " checked" : ""}> split</label></td>
        <td><input name="notes" form="${f}" value="${esc(k.notes || "")}" maxlength="500"></td>
        <td><form method="post" id="${f}"><input type="hidden" name="id" value="${k.id}"><button name="action" value="save">Save</button></form></td></tr>`;
    }).join("")}
    </tbody></table>
    <h2>Add a kit</h2>
    <form method="post" class="inline"><input type="hidden" name="action" value="add">
      <input name="label" placeholder="K02" required maxlength="20" pattern="[A-Za-z0-9-]+"><input name="notes" placeholder="Notes" maxlength="500"><button>Add kit</button></form>`, flash);
}

async function kitsPost(db, request) {
  const v = await readForm(request);
  if (v.action === "add") {
    if (!/^[A-Za-z0-9-]{1,20}$/.test(v.label || "")) return redirect("/admin/kits?msg=" + encodeURIComponent("Kit label: letters, numbers and dashes only."));
    const r = await db.prepare("INSERT OR IGNORE INTO kits (label, notes) VALUES (?, NULLIF(?, ''))").bind(v.label.toUpperCase(), v.notes || "").run();
    return redirect("/admin/kits?msg=" + encodeURIComponent(r.meta.changes ? `Added ${v.label.toUpperCase()}.` : "That label already exists."));
  }
  if (!KIT_STATUSES.includes(v.status)) return redirect("/admin/kits");
  const back = (m) => redirect("/admin/kits?msg=" + encodeURIComponent(m));
  const kit = await db.prepare("SELECT * FROM kits WHERE id = ?").bind(Number(v.id)).first();
  if (!kit) return back("Kit not found.");
  const lent = v.split_present ? (v.split === "on" ? KIT_TOTES : 0) : kit.totes_borrowed;
  if (lent && !kit.totes_borrowed) {
    // Only borrow from a kit with nothing booked: a booked kit needs all 12 totes.
    const busy = await db.prepare(
      `SELECT id FROM bookings WHERE kit_id = ? AND status IN ('confirmed','delivered','pickup_requested','pending')
         AND NOT (status = 'pending' AND hold_expires_at IS NOT NULL AND hold_expires_at < datetime('now')) LIMIT 1`).bind(kit.id).first();
    if (busy) return back(`${kit.label} has booking #${busy.id} on it. Split a kit with nothing booked.`);
  }
  if (!lent && kit.totes_borrowed) {
    // Un-splitting takes 12 totes out of the extra pool; refuse if bookings still need them.
    const s = await getSettings(db);
    const free = await addonPacksAvailable(db, s, today(), null);
    if (free < Math.ceil(kit.totes_borrowed / ADDON_PACK_SIZE))
      return back(`Extra totes from ${kit.label} are still booked or out. Leave it split until they're back.`);
  }
  await db.prepare("UPDATE kits SET status = ?, notes = NULLIF(?, ''), totes_borrowed = ? WHERE id = ?").bind(v.status, v.notes || "", lent, kit.id).run();
  return back(lent !== kit.totes_borrowed
    ? (lent ? `${kit.label} is split: its ${KIT_TOTES} totes are now extra totes, and it can't be booked until you uncheck it.` : `${kit.label} is whole again and bookable.`)
    : "Saved.");
}

// ---------- settings ----------

async function settingsPage(db, who, flash, url, env) {
  const s = await getSettings(db);
  const previewUrl = `${url.origin}/book?preview=${encodeURIComponent(s.booking_preview_key || "")}`;
  return page("Settings", who, `
    <section class="card"><h2>Online booking</h2>
      <form method="post" class="inline"><input type="hidden" name="section" value="booking">
        <label>Online booking <select name="online_booking"><option value="off"${s.online_booking !== "on" ? " selected" : ""}>OFF (preview link only)</option><option value="on"${s.online_booking === "on" ? " selected" : ""}>ON (public)</option></select></label>
        <button>Save</button></form>
      <p>Preview link (works while OFF): <a href="${esc(previewUrl)}" target="_blank" rel="noopener">${esc(previewUrl)}</a></p>
      <form method="post" class="inline"><input type="hidden" name="section" value="new_preview"><button>New preview link</button> <small class="muted">old link stops working</small></form>
      <p class="muted">PayPal: ${paypalReady(env) ? "connected" : "see Worker secrets"}. Turn ON only after the agreement is lawyer-reviewed and insurance is in place.</p>
    </section>
    <p class="muted">Prices are DRAFT until Phase 1 decisions are made. Changing them here affects new bookings only.</p>
    <form method="post" class="grid narrow">
      ${SETTING_FIELDS.map(([key, label, type]) => `<label>${esc(label)} <input name="${key}" ${type === "int" ? 'type="number" min="0" max="30"' : type === "count" ? 'type="number" min="0" max="9999"' : type === "money" ? 'inputmode="decimal"' : type === "longtext" ? 'maxlength="300"' : 'maxlength="50"'}
        value="${esc(type === "money" ? (Number(s[key] || 0) / 100).toFixed(2) : s[key] ?? "")}"></label>`).join("")}
      <button type="submit">Save settings</button></form>
    <h2>Hubs</h2>
    <p class="muted">Where customers pick up and return kits themselves. Addresses and hours go in their confirmation email and private booking page, never on the public site.
      Uncheck <b>Is a hub</b> to stop offering it.</p>
    <table><thead><tr><th>Name</th><th>Address</th><th>Hours</th><th>Is a hub</th><th></th></tr></thead><tbody>
      ${allHubs().map((h) => `<tr>
        <td><input form="hub-${esc(h.key)}" name="name" value="${esc(h.name)}" maxlength="40" required></td>
        <td><input form="hub-${esc(h.key)}" name="address" value="${esc(h.address || "")}" maxlength="200" placeholder="Street, city"></td>
        <td><input form="hub-${esc(h.key)}" name="hours" value="${esc(h.hours || "")}" maxlength="120" placeholder="e.g. Mon-Sat 8am-6pm"></td>
        <td><label class="check"><input type="checkbox" form="hub-${esc(h.key)}" name="active"${h.active ? " checked" : ""}> hub</label></td>
        <td><form method="post" id="hub-${esc(h.key)}"><input type="hidden" name="section" value="hub"><input type="hidden" name="key" value="${esc(h.key)}"><button>Save</button></form></td></tr>`).join("")}
    </tbody></table>
    <form method="post" class="inline" style="margin-top:8px"><input type="hidden" name="section" value="hub_add"><input name="name" placeholder="New hub name" maxlength="40" required><button>Add hub</button></form>
    <h2>Rental agreement text</h2>
    <p class="muted">Shown on the booking page; customers sign it. Change the version above whenever you change this text.</p>
    <form method="post" class="grid"><input type="hidden" name="section" value="agreement">
      <textarea name="agreement_text" style="min-height:360px;grid-column:1/-1">${esc(s.agreement_text || "")}</textarea>
      <button type="submit">Save agreement</button></form>`, flash);
}

async function settingsPost(db, request) {
  const v = await readForm(request);
  const put = (k, val) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(k, val);
  if (v.section === "booking") { await put("online_booking", v.online_booking === "on" ? "on" : "off").run(); return redirect("/admin/settings?msg=" + encodeURIComponent(`Online booking is ${v.online_booking === "on" ? "ON" : "OFF"}.`)); }
  if (v.section === "new_preview") {
    const key = [...crypto.getRandomValues(new Uint8Array(12))].map((x) => x.toString(16).padStart(2, "0")).join("");
    await put("booking_preview_key", key).run(); return redirect("/admin/settings?msg=" + encodeURIComponent("New preview link created."));
  }
  if (v.section === "hub") {
    if (!v.name) return redirect("/admin/settings?msg=" + encodeURIComponent("Hub needs a name."));
    if (v.active !== "on") {
      const others = await db.prepare("SELECT COUNT(*) n FROM hubs WHERE active = 1 AND key != ?").bind(v.key || "").first();
      const busy = await db.prepare(`SELECT id FROM bookings WHERE hub = ? AND status IN ('pending','confirmed','delivered','pickup_requested')
        AND NOT (status = 'pending' AND hold_expires_at IS NOT NULL AND hold_expires_at < datetime('now')) LIMIT 1`).bind(v.key || "").first();
      if (busy) return redirect("/admin/settings?msg=" + encodeURIComponent(`Booking #${busy.id} still uses this hub. Move it first, then turn the hub off.`));
      if (!others.n) { /* allowed: no hubs means no self pickup or hub returns */ }
    }
    await db.prepare("UPDATE hubs SET name = ?, address = NULLIF(?, ''), hours = NULLIF(?, ''), active = ? WHERE key = ?")
      .bind(v.name.slice(0, 40), (v.address || "").slice(0, 200), (v.hours || "").slice(0, 120), v.active === "on" ? 1 : 0, v.key || "").run();
    return redirect("/admin/settings?msg=" + encodeURIComponent(`Saved ${v.name} hub.`));
  }
  if (v.section === "hub_add") {
    const key = (v.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30);
    if (!key) return redirect("/admin/settings?msg=" + encodeURIComponent("Hub needs a name."));
    const r = await db.prepare("INSERT OR IGNORE INTO hubs (key, name, sort) VALUES (?, ?, (SELECT COALESCE(MAX(sort), 0) + 10 FROM hubs))").bind(key, v.name.slice(0, 40)).run();
    return redirect("/admin/settings?msg=" + encodeURIComponent(r.meta.changes ? `Added ${v.name} hub. Fill in its address and hours.` : "A hub with that name already exists."));
  }
  if (v.section === "agreement") { await put("agreement_text", (v.agreement_text || "").slice(0, 50000)).run(); return redirect("/admin/settings?msg=" + encodeURIComponent("Agreement saved.")); }
  const stmts = [];
  for (const [key, , type] of SETTING_FIELDS) {
    if (!(key in v)) continue;
    let val = v[key];
    if (type === "money") { const c = toCents(val); if (c === null) return redirect("/admin/settings?msg=" + encodeURIComponent("Prices must be dollar amounts.")); val = String(c); }
    if (type === "int") { const n = Number(val); if (!Number.isInteger(n) || n < 0 || n > 30) return redirect("/admin/settings?msg=" + encodeURIComponent("Day counts must be 0-30.")); val = String(n); }
    if (type === "count") { const n = Number(val); if (!Number.isInteger(n) || n < 0 || n > 9999) return redirect("/admin/settings?msg=" + encodeURIComponent("Counts must be whole numbers.")); val = String(n); }
    if ((type === "text" || type === "longtext") && !val) continue;
    stmts.push(db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, val));
  }
  if (stmts.length) await db.batch(stmts);
  return redirect("/admin/settings?msg=" + encodeURIComponent("Settings saved."));
}

// ---------- billing actions ----------

async function billingAction(db, who, b, v, env) {
  const back = (msg) => redirect(`/admin/bookings/${b.id}?msg=${encodeURIComponent(msg)}`);
  if (!paypalReady(env)) return back("PayPal is not connected.");
  if (v.action === "cancel_billing") {
    if (!b.paypal_subscription_id) return back("No PayPal billing on this booking.");
    const r = await cancelSubscription(env, b.paypal_subscription_id, `Booking ${b.id}: equipment picked up`);
    if (!r.ok && r.status !== 422) return back(`PayPal refused (${r.status}). Nothing changed.`);
    await db.prepare("UPDATE bookings SET billing_status = 'CANCELLED' WHERE id = ?").bind(b.id).run();
    await logEvent(db, b.id, who, "billing", "billing stopped by admin");
    return back("Billing stopped.");
  }
  if (v.action === "refund_rental") {
    const pays = (await db.prepare("SELECT * FROM payments WHERE booking_id = ? ORDER BY id").bind(b.id).all()).results;
    const rr = rentalRefundInfo(b, pays);
    const amt = toCents(v.amount || "");
    if (!rr) return back("There's no rental payment to refund.");
    if (!amt || amt <= 0) return back("Enter a refund amount.");
    if (amt > rr.left) return back(`That's more than the ${money(rr.left)} left on the last rental payment.`);
    const r = await refundSale(env, rr.saleId, amt);
    if (!r.ok) return back(`PayPal refused the refund (${r.status}). Nothing changed.`);
    await db.prepare("INSERT OR IGNORE INTO payments (booking_id, kind, amount_cents, paypal_id, status, refund_of) VALUES (?, 'refund', ?, ?, ?, ?)")
      .bind(b.id, amt, r.data.id || null, r.data.state || "completed", rr.saleId).run();
    await logEvent(db, b.id, who, "refund", `rental refund ${money(amt)} via PayPal (${rr.note})`);
    return back(`Refunded ${money(amt)} of rent.`);
  }
  const cents = toCents(v.amount || "");
  const left = b.deposit_cents - b.deposit_refunded_cents;
  if (!cents || cents <= 0) return back("Enter a refund amount.");
  if (cents > left) return back(`Refund is more than the ${money(left)} deposit left.`);
  const setup = await db.prepare("SELECT paypal_id FROM payments WHERE booking_id = ? AND kind = 'setup'").bind(b.id).first();
  if (!setup) return back("The deposit payment hasn't been recorded yet, so there is nothing to refund.");
  const r = await refundSale(env, setup.paypal_id, cents);
  if (!r.ok) return back(`PayPal refused the refund (${r.status}). Nothing changed.`);
  await db.batch([
    db.prepare("UPDATE bookings SET deposit_refunded_cents = deposit_refunded_cents + ? WHERE id = ?").bind(cents, b.id),
    db.prepare("INSERT OR IGNORE INTO payments (booking_id, kind, amount_cents, paypal_id, status, refund_of) VALUES (?, 'refund', ?, ?, ?, ?)")
      .bind(b.id, cents, r.data.id || null, r.data.state || "completed", setup.paypal_id),
  ]);
  await logEvent(db, b.id, who, "refund", `deposit refund ${money(cents)} via PayPal${cents < left ? ` (kept ${money(left - cents)})` : ""}`);
  await db.prepare("UPDATE bookings SET deposit_settled_at = datetime('now') WHERE id = ?").bind(b.id).run();
  await refundEmail(db, env, b.id, { depositRefund: cents, kept: left - cents, reason: v.reason || "" });
  return back(`Refunded ${money(cents)}. Customer emailed.`);
}

// Storage policy (2026-11-23): the FIRST month is a minimum (no refund). For renewal months, after pickup,
// refund each unused FULL week of the last paid month at monthly x 12 / 52. Moving plan: 2-week minimum,
// partial weeks not refunded. The amount stays editable so Christian can make exceptions.
function rentalRefundInfo(b, pays) {
  const rentals = pays.filter((p) => p.kind === "rental" && p.paypal_id);
  if (!rentals.length) return null;
  const last = rentals[rentals.length - 1];
  const refunded = pays.filter((p) => p.kind === "refund" && p.refund_of === last.paypal_id).reduce((a, p) => a + p.amount_cents, 0);
  const left = last.amount_cents - refunded;
  if (left <= 0) return null;
  let suggest = 0, note = b.plan === "moving" ? "Moving plan: 2-week minimum, partial weeks aren't refunded." : "Set a pickup date to calculate unused weeks.";
  // The first period is paid at booking (setup sale), so every "rental" payment here is a renewal.
  if (b.plan === "storage" && b.pickup_date) {
    const paid = new Date(last.created_at.replace(" ", "T") + "Z");
    const periodStart = paid.toLocaleDateString("en-CA", { timeZone: TZ });
    const d = new Date(periodStart + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + 1);
    const periodEnd = d.toISOString().slice(0, 10); // first day of the next billing month
    const unusedDays = Math.round((Date.parse(periodEnd + "T12:00:00Z") - Date.parse(b.pickup_date + "T12:00:00Z")) / 86400000);
    const weeks = Math.max(0, Math.floor(unusedDays / 7));
    const weekly = Math.round((b.rate_recurring_cents || 0) * 12 / 52);
    suggest = Math.max(0, Math.min(weeks * weekly - refunded, left)); // minus anything already refunded from this payment
    note = `Paid ${periodStart} for the month to ${periodEnd}; pickup ${b.pickup_date} leaves ${Math.max(0, unusedDays)} days = ${weeks} full week${weeks === 1 ? "" : "s"} × ${money(weekly)}.`;
  }
  return { saleId: last.paypal_id, left, suggest, note };
}

// ---------- complete pickup (onsite, phone-friendly) ----------

async function completePickup(db, who, b, v, env) {
  const back = (msg) => redirect(`/admin/bookings/${b.id}?msg=${encodeURIComponent(msg)}`);
  if (!["delivered", "pickup_requested"].includes(b.status)) return back("This booking isn't out right now.");
  const left = b.deposit_cents - b.deposit_refunded_cents;
  const items = (await db.prepare("SELECT * FROM price_items WHERE active = 1 ORDER BY sort, name").all()).results;
  const charges = [];
  for (const it of items.filter((i) => i.kind !== "handling")) {
    const raw = String(v[`q_${it.key}`] ?? "0").trim() || "0";
    const qty = Number(raw);
    if (!Number.isInteger(qty) || qty < 0 || qty > 99) return back(`${it.name}: enter a whole number.`);
    if (qty > 0) charges.push({ name: it.name, qty: it.kind === "cleaning" ? 1 : qty, cents: it.kind === "cleaning" ? it.price_cents : lineCharge(it, qty), kind: it.kind, pack: it.pack_size });
  }
  const hand = items.find((i) => i.kind === "handling");
  if (hand && charges.some((c) => c.kind === "item")) charges.push({ name: hand.name, qty: 1, cents: hand.price_cents, kind: "handling", pack: 1 });
  const extra = toCents(v.extra || "0");
  const extraReason = (v.extra_reason || "").trim();
  if (extra === null) return back("Other charge must be a dollar amount.");
  if (extra > 0 && !extraReason) return back("Add a reason for the other charge (the customer sees it).");
  if (extra > 0) charges.push({ name: extraReason, qty: 1, cents: extra, kind: "other", pack: 1 });
  const total = charges.reduce((a, c) => a + c.cents, 0);
  const kept = Math.min(total, left);
  const owed = total - kept;
  const describe = (c) => c.kind === "item" ? `${c.qty} × ${c.name}${c.pack > 1 ? ` (pack of ${c.pack})` : ""}: ${money(c.cents)}` : `${c.name}: ${money(c.cents)}`;
  const reason = charges.map(describe).join("; ");
  const missing = charges.filter((c) => c.kind === "item").map((c) => `${c.qty} × ${c.name}`);
  const t = today();
  const pays = (await db.prepare("SELECT * FROM payments WHERE booking_id = ? ORDER BY id").bind(b.id).all()).results;
  const online = Boolean(b.paypal_subscription_id);
  if (online && !paypalReady(env)) return back("PayPal is not connected; nothing changed.");
  const notes = [], problems = [];
  let depositRefund = 0, weeksRefund = 0;
  const refundCents = left - kept;

  if (online) {
    // Stop billing first so no renewal can land after the kit is back.
    if (!["CANCELLED", "EXPIRED"].includes(b.billing_status || "")) {
      const r = await cancelSubscription(env, b.paypal_subscription_id, `Booking ${b.id}: equipment picked up`);
      if (r.ok || r.status === 422) {
        await db.prepare("UPDATE bookings SET billing_status = 'CANCELLED' WHERE id = ?").bind(b.id).run();
        notes.push("billing stopped");
      } else problems.push(`PayPal didn't stop billing (${r.status}); use Stop billing`);
    }
    if (refundCents > 0) {
      const setup = pays.find((p) => p.kind === "setup");
      if (!setup) problems.push("deposit payment not recorded yet, so no deposit refund was sent");
      else {
        const r = await refundSale(env, setup.paypal_id, refundCents);
        if (r.ok) {
          depositRefund = refundCents;
          await db.batch([
            db.prepare("UPDATE bookings SET deposit_refunded_cents = deposit_refunded_cents + ? WHERE id = ?").bind(refundCents, b.id),
            db.prepare("INSERT OR IGNORE INTO payments (booking_id, kind, amount_cents, paypal_id, status, refund_of) VALUES (?, 'refund', ?, ?, ?, ?)")
              .bind(b.id, refundCents, r.data.id || null, r.data.state || "completed", setup.paypal_id),
          ]);
          notes.push(`deposit refund ${money(refundCents)}`);
        } else problems.push(`PayPal refused the deposit refund (${r.status}); use the Refund button`);
      }
    }
    const rr = rentalRefundInfo({ ...b, pickup_date: t }, pays);
    if (v.refund_weeks === "on" && b.plan === "storage" && rr && rr.suggest > 0) {
      const r = await refundSale(env, rr.saleId, rr.suggest);
      if (r.ok) {
        weeksRefund = rr.suggest;
        await db.prepare("INSERT OR IGNORE INTO payments (booking_id, kind, amount_cents, paypal_id, status, refund_of) VALUES (?, 'refund', ?, ?, ?, ?)")
          .bind(b.id, rr.suggest, r.data.id || null, r.data.state || "completed", rr.saleId).run();
        notes.push(`unused weeks refund ${money(rr.suggest)}`);
      } else problems.push(`PayPal refused the unused-weeks refund (${r.status})`);
    }
  } else {
    // Manual booking: money was handled outside PayPal; just record it.
    depositRefund = refundCents;
    await db.prepare("UPDATE bookings SET deposit_refunded_cents = deposit_refunded_cents + ? WHERE id = ?").bind(refundCents, b.id).run();
    notes.push(`deposit refund ${money(refundCents)} recorded (pay it back the way they paid)`);
  }

  const settled = !problems.some((p) => p.includes("deposit"));
  await db.prepare(
    `UPDATE bookings SET status = 'returned', pickup_date = ?, returned_at = datetime('now'), deposit_kept_cents = deposit_kept_cents + ?,
       deposit_kept_reason = COALESCE(NULLIF(?, ''), deposit_kept_reason), balance_owed_cents = balance_owed_cents + ?,
       deposit_settled_at = CASE WHEN ? THEN datetime('now') ELSE deposit_settled_at END,
       updated_at = datetime('now') WHERE id = ?`).bind(t, kept, reason, owed, settled ? 1 : 0, b.id).run();
  await logEvent(db, b.id, who, "pickup completed",
    [charges.length ? `CHARGES ${money(total)}: ${reason}` : "everything back, no charges", owed ? `OWED beyond deposit: ${money(owed)}` : "", ...notes, ...problems]
      .filter(Boolean).join("; "));
  if (settled) await refundEmail(db, env, b.id, { depositRefund, kept, weeksRefund, charges: charges.map(describe), owed, pickedUp: true });
  return back(problems.length ? `Pickup completed, but: ${problems.join("; ")}.` : `Pickup completed: ${notes.join(", ")}. Customer emailed.`);
}

async function refundEmail(db, env, id, { depositRefund = 0, kept = 0, reason = "", weeksRefund = 0, charges = [], owed = 0, pickedUp = false }) {
  const b = await db.prepare("SELECT b.*, c.name, c.email FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.id = ?").bind(id).first();
  if (!b || !b.email) return;
  const owner = String(env.CONTACT_EMAIL || "").trim();
  const lines = [
    `Hi ${b.name},`, "",
    pickedUp ? "We picked up your totes today. Thanks for renting with us!" : "Here's an update on your deposit.", "",
    `Deposit: ${money(b.deposit_cents)}`,
    ...(charges.length ? ["", "Charges (from our price list at 3totes.com/prices):", ...charges.map((c) => `  - ${c}`), ""] : []),
    ...(kept ? [`Kept from deposit: ${money(kept)}${reason && !charges.length ? ` for ${reason}` : ""}`] : []),
    `Refunded: ${money(depositRefund)}`,
    ...(weeksRefund ? [`Unused storage weeks refunded: ${money(weeksRefund)}`] : []),
    ...(owed ? ["", `Remaining balance: ${money(owed)} (charges above your deposit). We'll send you an invoice.`] : []),
    "",
    b.paypal_subscription_id
      ? "Refunds go back to the payment method you used through PayPal. Your bank may take a few business days to show it."
      : "We'll return your refund the same way you paid.",
    ...(pickedUp && b.paypal_subscription_id ? ["Your rental billing has stopped."] : []),
    "", "Questions? Just reply to this email.", "", "Totes Totes Totes", "3totes.com",
  ];
  await trySend(env, {
    to: b.email, subject: pickedUp ? "Pickup complete: your deposit refund" : "Your deposit refund", text: lines.join("\n"),
    replyTo: owner ? `<${owner}>` : undefined,
  });
}

// ---------- price list ----------

async function pricesPage(db, who, flash) {
  const items = (await db.prepare("SELECT * FROM price_items ORDER BY active DESC, sort, name").all()).results;
  const row = (i) => `<tr${i.active ? "" : ' class="muted"'}>
      <td><input form="p-${esc(i.key)}" name="name" value="${esc(i.name)}" maxlength="80" required></td>
      <td>${esc({ item: "Kit item", cleaning: "Cleaning", handling: "Replacement trip" }[i.kind])}</td>
      <td>${i.kind === "item" ? `<input form="p-${esc(i.key)}" name="kit_qty" type="number" min="0" max="99" value="${i.kit_qty ?? ""}" style="width:70px">` : ""}</td>
      <td>${i.kind === "item" ? `<input form="p-${esc(i.key)}" name="pack_size" type="number" min="1" max="99" value="${i.pack_size}" style="width:70px">` : ""}</td>
      <td><input form="p-${esc(i.key)}" name="price" inputmode="decimal" value="${(i.price_cents / 100).toFixed(2)}" style="width:90px"></td>
      <td><input form="p-${esc(i.key)}" name="note" value="${esc(i.note || "")}" maxlength="200"></td>
      <td><select form="p-${esc(i.key)}" name="active"><option value="1"${i.active ? " selected" : ""}>Shown</option><option value="0"${i.active ? "" : " selected"}>Hidden</option></select></td>
      <td><form method="post" id="p-${esc(i.key)}"><input type="hidden" name="action" value="save"><input type="hidden" name="key" value="${esc(i.key)}"><button>Save</button></form></td></tr>`;
  return page("Price list", who, `
    <p class="muted">Replacement charges used at Complete pickup and shown publicly at <a href="/prices" target="_blank">3totes.com/prices</a>.
      Pack size above 1 means any missing piece is charged as a whole pack. The replacement trip is added once whenever something has to be replaced.</p>
    <table><thead><tr><th>Item</th><th>Type</th><th>Kit has</th><th>Pack size</th><th>Price</th><th>Note (public)</th><th></th><th></th></tr></thead>
      <tbody>${items.map(row).join("")}</tbody></table>
    <h2>Add an item</h2>
    <form method="post" class="inline"><input type="hidden" name="action" value="add">
      <input name="name" placeholder="Item name" required maxlength="80"><input name="kit_qty" type="number" min="0" placeholder="Kit has" style="width:90px">
      <input name="pack_size" type="number" min="1" value="1" style="width:80px" title="Pack size"><input name="price" placeholder="Price $" inputmode="decimal" style="width:90px" required>
      <button>Add</button></form>`, flash);
}

async function pricesPost(db, request) {
  const v = await readForm(request);
  const back = (m) => redirect("/admin/prices?msg=" + encodeURIComponent(m));
  const price = toCents(v.price || "");
  if (price === null) return back("Price must be a dollar amount.");
  const pack = Math.max(1, Math.min(99, parseInt(v.pack_size || "1", 10) || 1));
  const kitQty = v.kit_qty === "" || v.kit_qty === undefined ? null : Math.max(0, Math.min(99, parseInt(v.kit_qty, 10) || 0));
  if (!v.name) return back("Give the item a name.");
  if (v.action === "add") {
    const key = v.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "item";
    const r = await db.prepare(`INSERT OR IGNORE INTO price_items (key, name, kind, kit_qty, pack_size, price_cents, sort)
      VALUES (?, ?, 'item', ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM price_items WHERE kind = 'item'))`)
      .bind(key, v.name.slice(0, 80), kitQty, pack, price).run();
    return back(r.meta.changes ? `Added ${v.name}.` : "An item with that name already exists.");
  }
  await db.prepare(`UPDATE price_items SET name = ?, price_cents = ?, note = NULLIF(?, ''), active = ?,
      kit_qty = CASE WHEN kind = 'item' THEN ? ELSE kit_qty END, pack_size = CASE WHEN kind = 'item' THEN ? ELSE pack_size END WHERE key = ?`)
    .bind(v.name.slice(0, 80), price, (v.note || "").slice(0, 200), v.active === "0" ? 0 : 1, kitQty, pack, v.key || "").run();
  return back(`Saved ${v.name}.`);
}

// ---------- zones ----------

async function zonesPage(db, who, flash) {
  const zones = (await db.prepare("SELECT * FROM zones ORDER BY hub, zone, zip").all()).results;
  const wait = (await db.prepare("SELECT zip, COUNT(*) n FROM waitlist GROUP BY zip ORDER BY n DESC LIMIT 20").all()).results;
  return page("Delivery zones", who, `
    <p class="muted">Only these zip codes can book online. Fee 0 = free delivery.</p>
    ${zones.length ? `<table><thead><tr><th>Zip</th><th>Zone</th><th>Delivery fee</th><th>Hub</th><th></th></tr></thead><tbody>
      ${zones.map((z) => `<tr><td>${esc(z.zip)}</td><td>${esc(z.zone)}</td><td>${money(z.delivery_fee_cents)}</td><td>${esc(z.hub)}</td>
        <td><form method="post" onsubmit="return confirm('Remove ${esc(z.zip)}?')"><input type="hidden" name="action" value="delete"><input type="hidden" name="zip" value="${esc(z.zip)}"><button>Remove</button></form></td></tr>`).join("")}
      </tbody></table>` : `<p class="error">No zip codes yet: nobody can book online until you add some.</p>`}
    <h2>Add or update zip codes</h2>
    <form method="post" class="inline"><input type="hidden" name="action" value="add">
      <input name="zips" placeholder="63801, 63834 ..." required style="min-width:260px">
      <input name="zone" placeholder="Zone (e.g. Sikeston local)" required maxlength="50">
      <input name="fee" placeholder="Fee $" inputmode="decimal" value="0" style="width:90px">
      <select name="hub">${allHubs().map((h) => `<option value="${esc(h.key)}">${esc(h.name)}</option>`).join("")}</select>
      <button>Save</button></form>
    <h2>Waitlist</h2>
    ${wait.length ? `<ul>${wait.map((w) => `<li>${esc(w.zip || "no zip")}: ${w.n} ${w.n === 1 ? "person" : "people"}</li>`).join("")}</ul>` : `<p class="muted">Nobody yet.</p>`}`, flash);
}

async function zonesPost(db, request) {
  const v = await readForm(request);
  const back = (m) => redirect("/admin/zones?msg=" + encodeURIComponent(m));
  if (v.action === "delete") { await db.prepare("DELETE FROM zones WHERE zip = ?").bind(v.zip || "").run(); return back(`Removed ${v.zip}.`); }
  const zips = [...new Set((v.zips || "").split(/[\s,]+/).filter(Boolean))];
  if (!zips.length || zips.some((z) => !/^\d{5}$/.test(z))) return back("Zip codes must be 5 digits, separated by commas or spaces.");
  const fee = toCents(v.fee || "0");
  if (fee === null) return back("Fee must be a dollar amount.");
  if (!v.zone) return back("Give the zone a name.");
  const hub = allHubs().some((h) => h.key === v.hub) ? v.hub : (allHubs()[0] || {}).key || "sikeston";
  await db.batch(zips.map((z) => db.prepare(
    "INSERT INTO zones (zip, zone, delivery_fee_cents, hub) VALUES (?, ?, ?, ?) ON CONFLICT (zip) DO UPDATE SET zone = excluded.zone, delivery_fee_cents = excluded.delivery_fee_cents, hub = excluded.hub")
    .bind(z, v.zone.slice(0, 50), fee, hub)));
  return back(`Saved ${zips.length} zip code${zips.length === 1 ? "" : "s"}.`);
}

// ---------- styles ----------

const CSS = `
:root{--ink:#111;--muted:#666;--line:#ddd;--bg:#fafaf7;--card:#fff;--yellow:#f5c400;--red:#b3261e}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;padding:10px 16px;background:var(--ink);color:#fff}
header a{color:#fff;text-decoration:none}header nav{display:flex;flex-wrap:wrap;gap:4px 16px}header nav a:hover{color:var(--yellow)}
.brand{font-weight:700;color:var(--yellow)!important}.who{margin-left:auto;font-size:.85rem;opacity:.75}
main{max-width:1200px;margin:0 auto;padding:16px}h1{font-size:1.5rem;margin:.4em 0 .6em}h2{font-size:1.1rem;margin:1.4em 0 .5em}
a{color:#0b57d0}.muted{color:var(--muted)}small{color:var(--muted)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:.8rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted)}
tr.today td{background:#fff8d6}tr.late td{background:#fde8e6}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.8rem;background:#eee;white-space:nowrap}
.s-confirmed{background:#e3f0ff}.s-pending{background:#fff3c4}.s-delivered{background:#dff5e1}.s-pickup_requested{background:#ffe2c4}.s-returned,.s-closed{background:#eee}.s-cancelled{background:#f3d6d3}
.flash{background:#dff5e1;padding:8px 12px;border-radius:6px}.error{background:#fde8e6;color:var(--red);padding:8px 12px;border-radius:6px}
form.grid{display:grid;gap:12px}form.grid.narrow{max-width:420px}fieldset{border:1px solid var(--line);border-radius:8px;padding:12px;display:grid;gap:10px;background:var(--card)}
label{display:grid;gap:4px;font-size:.9rem}input,select,textarea{font:inherit;padding:7px 9px;border:1px solid #bbb;border-radius:6px;background:#fff;width:100%}
textarea{min-height:80px}button,.button{font:inherit;font-weight:600;padding:8px 16px;border:0;border-radius:6px;background:var(--yellow);color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block;white-space:nowrap}
form.filters,form.inline{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}form.filters input{flex:1;min-width:200px}form.filters select,form.inline input{width:auto}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:4px 16px 16px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0}dt{color:var(--muted)}dd{margin:0}
label.check{display:flex;gap:8px;align-items:center}label.qty{display:flex;gap:10px;align-items:center;justify-content:space-between}label.qty input{width:80px}.owed{color:var(--red)}label.check input{width:auto}.card.complete{border:2px solid var(--yellow)}
.events{list-style:none;padding:0}.events li{padding:6px 0;border-bottom:1px solid var(--line)}.events time{font-size:.8rem;color:var(--muted)}
@media (min-width:900px){form.grid:not(.narrow){grid-template-columns:repeat(3,1fr);align-items:start}form.grid:not(.narrow)>button{grid-column:1/-1;justify-self:start}}
@media (max-width:700px){table,thead,tbody,tr,td{display:block}thead{display:none}tr{border-bottom:2px solid var(--line)}td{border:0;padding:4px 10px}}
`;
