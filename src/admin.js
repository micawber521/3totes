// /admin: server-rendered pages for Christian (owner) and drivers.
// Step 1 of BOOKING_DESIGN: kits, manual bookings, schedule, settings. No payments yet.
import { adminIdentity } from "./access.js";
import { ensureSchema, getSettings, kitConflict } from "./db.js";

const TZ = "America/Chicago";
const STATUSES = ["pending", "confirmed", "delivered", "pickup_requested", "returned", "closed", "cancelled"];
const STATUS_LABEL = {
  pending: "Pending", confirmed: "Confirmed", delivered: "Delivered", pickup_requested: "Pickup requested",
  returned: "Returned", closed: "Closed", cancelled: "Cancelled",
};
const KIT_STATUSES = ["active", "cleaning", "retired"];
const SETTING_FIELDS = [
  ["deposit_cents", "Deposit", "money"],
  ["moving_first_cents", "Moving plan, first 2 weeks", "money"],
  ["moving_weekly_cents", "Moving plan, each week after", "money"],
  ["storage_monthly_cents", "Storage plan, monthly", "money"],
  ["buffer_days", "Turnaround days between rentals", "int"],
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
    ? `<a href="/admin">Schedule</a><a href="/admin/bookings">Bookings</a><a href="/admin/bookings/new">New booking</a><a href="/admin/kits">Kits</a><a href="/admin/settings">Settings</a>`
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
  if (m && request.method === "POST") return bookingUpdate(db, who, Number(m[1]), request);
  if (path === "/admin/kits") return request.method === "POST" ? kitsPost(db, request) : kitsPage(db, who, flash);
  if (path === "/admin/settings") return request.method === "POST" ? settingsPost(db, request) : settingsPage(db, who, flash);
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
    `SELECT b.id, b.delivery_date, b.pickup_date, c.name, k.label AS kit FROM bookings b
       JOIN customers c ON c.id = b.customer_id JOIN kits k ON k.id = b.kit_id
      WHERE b.status IN ('delivered','pickup_requested') ORDER BY b.delivery_date`).all()).results;

  const isOwner = who.role === "owner";
  const stop = (b, date, kind) => {
    const late = date && date < t;
    const name = isOwner ? `<a href="/admin/bookings/${b.id}">${esc(b.name)}</a>` : esc(b.name);
    const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address + " " + b.zip)}`;
    return `<tr class="${late ? "late" : date === t ? "today" : ""}">
      <td>${date ? esc(niceDate(date)) : "<em>no date</em>"}${late ? " <b>overdue</b>" : ""}</td>
      <td>${name}<br><small>${esc(b.phone || "")}</small></td>
      <td><a href="${esc(map)}" target="_blank" rel="noopener">${esc(b.address)}, ${esc(b.zip)}</a>${b.notes ? `<br><small>${esc(b.notes)}</small>` : ""}</td>
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
      ? `<ul>${out.map((b) => `<li>${esc(b.kit)}: ${isOwner ? `<a href="/admin/bookings/${b.id}">${esc(b.name)}</a>` : esc(b.name)} since ${esc(niceDate(b.delivery_date))}${b.pickup_date ? `, pickup ${esc(niceDate(b.pickup_date))}` : ", open-ended"}</li>`).join("")}</ul>`
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
      </fieldset>
      <fieldset><legend>Rental</legend>
        <label>Plan <select name="plan">
          <option value="moving"${plan === "moving" ? " selected" : ""}>Moving: ${money(s.moving_first_cents)} first 2 weeks, then ${money(s.moving_weekly_cents)}/week</option>
          <option value="storage"${plan === "storage" ? " selected" : ""}>Storage: ${money(s.storage_monthly_cents)}/month</option></select></label>
        <label>Kit <select name="kit_id">${kits.map((k) => `<option value="${k.id}"${String(k.id) === String(v.kit_id) ? " selected" : ""}>${esc(k.label)}${k.status === "cleaning" ? " (cleaning)" : ""}</option>`).join("")}</select></label>
        <label>Deposit <input name="deposit" inputmode="decimal" value="${esc(v.deposit ?? (Number(s.deposit_cents || 0) / 100).toFixed(2))}"></label>
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
  const deposit = toCents(v.deposit || "0");
  if (deposit === null) return fail("Deposit must be a dollar amount.");
  const kit = await db.prepare("SELECT id, label, status FROM kits WHERE id = ?").bind(Number(v.kit_id)).first();
  if (!kit || kit.status === "retired") return fail("Pick a kit.");

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
    `INSERT INTO bookings (customer_id, kit_id, plan, status, address, zip, delivery_date, pickup_date, notes, deposit_cents, agreement_version, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, 'admin') RETURNING id`)
    .bind(customer.id, kit.id, v.plan, status, v.address, v.zip, v.delivery_date, v.pickup_date || "", v.notes || "", deposit, s.agreement_version || null).first();
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
  return page(`Booking #${b.id}: ${b.name}`, who, `
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <div class="cols">
      <section class="card"><h2>Details</h2><dl>
        <dt>Status</dt><dd>${badge(b.status)}</dd>
        <dt>Customer</dt><dd>${esc(b.name)}<br>${esc(b.phone || "")}${b.email ? `<br><a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : ""}</dd>
        <dt>Address</dt><dd>${esc(b.address)}, ${esc(b.zip)}</dd>
        <dt>Plan</dt><dd>${esc(b.plan)}</dd>
        <dt>Kit</dt><dd>${esc(b.kit)}</dd>
        <dt>Delivery</dt><dd>${esc(niceDate(b.delivery_date))}, first thing in the morning</dd>
        <dt>Pickup</dt><dd>${b.pickup_date ? esc(niceDate(b.pickup_date)) : "Open-ended"}</dd>
        <dt>Deposit</dt><dd>${money(b.deposit_cents)}${b.deposit_refunded_cents ? `, refunded ${money(b.deposit_refunded_cents)}` : ""}</dd>
        <dt>Agreement</dt><dd>${b.signed_at ? `Signed by ${esc(b.signed_name)} at ${esc(b.signed_at)}` : `Not signed online (${esc(b.agreement_version || "no version")})`}</dd>
        <dt>Source</dt><dd>${esc(b.source)}, created ${esc(b.created_at)} UTC</dd>
      </dl></section>
      <section class="card"><h2>Update</h2>
        <form method="post" class="grid">
          <label>Status <select name="status">${STATUSES.map((s) => `<option value="${s}"${s === b.status ? " selected" : ""}>${esc(STATUS_LABEL[s])}</option>`).join("")}</select></label>
          <label>Kit <select name="kit_id">${kits.map((k) => `<option value="${k.id}"${k.id === b.kit_id ? " selected" : ""}>${esc(k.label)}</option>`).join("")}</select></label>
          <label>Delivery date <input name="delivery_date" type="date" required value="${esc(b.delivery_date)}"></label>
          <label>Pickup date <small>(blank = open-ended)</small> <input name="pickup_date" type="date" value="${esc(b.pickup_date || "")}"></label>
          <label>Deposit refunded <input name="deposit_refunded" inputmode="decimal" value="${(b.deposit_refunded_cents / 100).toFixed(2)}"></label>
          <label>Notes <textarea name="notes" maxlength="2000">${esc(b.notes || "")}</textarea></label>
          <label>Log note <small>(added to the history)</small> <input name="log" maxlength="500"></label>
          <button type="submit">Save</button>
        </form></section>
    </div>
    <h2>History</h2>
    ${events.length ? `<ul class="events">${events.map((e) => `<li><time>${esc(e.at)} UTC</time> <b>${esc(e.action)}</b> ${esc(e.detail || "")} <small class="muted">${esc(e.by_email || "")}</small></li>`).join("")}</ul>` : `<p class="muted">No history.</p>`}`, flash);
}

async function bookingUpdate(db, who, id, request) {
  const b = await db.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first();
  if (!b) return deny(404, "Not found");
  const v = await readForm(request);
  const s = await getSettings(db);
  const fail = (msg) => bookingView(db, who, id, "", msg);

  const status = STATUSES.includes(v.status) ? v.status : b.status;
  if (!isDate(v.delivery_date)) return fail("Delivery date is not valid.");
  if (v.pickup_date && !isDate(v.pickup_date)) return fail("Pickup date is not valid.");
  if (v.pickup_date && v.pickup_date < v.delivery_date) return fail("Pickup date is before the delivery date.");
  const refunded = toCents(v.deposit_refunded || "0");
  if (refunded === null) return fail("Deposit refunded must be a dollar amount.");
  if (refunded > b.deposit_cents) return fail("Refund is more than the deposit.");
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
  if ((v.notes || "") !== (b.notes || "")) changes.push("notes edited");

  await db.prepare(
    `UPDATE bookings SET status = ?, kit_id = ?, delivery_date = ?, pickup_date = NULLIF(?, ''), deposit_refunded_cents = ?,
       notes = NULLIF(?, ''), updated_at = datetime('now') WHERE id = ?`)
    .bind(status, kitId, v.delivery_date, v.pickup_date || "", refunded, v.notes || "", id).run();
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
            (SELECT MIN(b.delivery_date) FROM bookings b
              WHERE b.kit_id = k.id AND b.status IN ('pending','confirmed') AND b.delivery_date >= ?) AS next_drop
       FROM kits k ORDER BY k.status = 'retired', k.label`).bind(t).all()).results;
  return page("Kits", who, `
    <table><thead><tr><th>Kit</th><th>Where</th><th>Next drop-off</th><th>Status</th><th>Notes</th><th></th></tr></thead><tbody>
    ${kits.map((k) => {
      const [bid, bname] = (k.out_with || "").split("|");
      const f = `kit-${k.id}`;
      return `<tr>
        <td><b>${esc(k.label)}</b></td>
        <td>${k.out_with ? `Out: <a href="/admin/bookings/${esc(bid)}">${esc(bname)}</a>` : k.status === "retired" ? "Retired" : "Home"}</td>
        <td>${k.next_drop ? esc(niceDate(k.next_drop)) : "<span class='muted'>none</span>"}</td>
        <td><select name="status" form="${f}">${KIT_STATUSES.map((s) => `<option${s === k.status ? " selected" : ""}>${s}</option>`).join("")}</select></td>
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
  await db.prepare("UPDATE kits SET status = ?, notes = NULLIF(?, '') WHERE id = ?").bind(v.status, v.notes || "", Number(v.id)).run();
  return redirect("/admin/kits?msg=" + encodeURIComponent("Saved."));
}

// ---------- settings ----------

async function settingsPage(db, who, flash) {
  const s = await getSettings(db);
  return page("Settings", who, `
    <p class="muted">Prices are DRAFT until Phase 1 decisions are made. Changing them here affects new bookings only.</p>
    <form method="post" class="grid narrow">
      ${SETTING_FIELDS.map(([key, label, type]) => `<label>${esc(label)} <input name="${key}" ${type === "int" ? 'type="number" min="0" max="30"' : type === "money" ? 'inputmode="decimal"' : 'maxlength="50"'}
        value="${esc(type === "money" ? (Number(s[key] || 0) / 100).toFixed(2) : s[key] ?? "")}"></label>`).join("")}
      <button type="submit">Save settings</button></form>`, flash);
}

async function settingsPost(db, request) {
  const v = await readForm(request);
  const stmts = [];
  for (const [key, , type] of SETTING_FIELDS) {
    if (!(key in v)) continue;
    let val = v[key];
    if (type === "money") { const c = toCents(val); if (c === null) return redirect("/admin/settings?msg=" + encodeURIComponent("Prices must be dollar amounts.")); val = String(c); }
    if (type === "int") { const n = Number(val); if (!Number.isInteger(n) || n < 0 || n > 30) return redirect("/admin/settings?msg=" + encodeURIComponent("Turnaround days must be 0-30.")); val = String(n); }
    if (type === "text" && !val) continue;
    stmts.push(db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, val));
  }
  if (stmts.length) await db.batch(stmts);
  return redirect("/admin/settings?msg=" + encodeURIComponent("Settings saved."));
}

// ---------- styles ----------

const CSS = `
:root{--ink:#111;--muted:#666;--line:#ddd;--bg:#fafaf7;--card:#fff;--yellow:#f5c400;--red:#b3261e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
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
.events{list-style:none;padding:0}.events li{padding:6px 0;border-bottom:1px solid var(--line)}.events time{font-size:.8rem;color:var(--muted)}
@media (min-width:900px){form.grid:not(.narrow){grid-template-columns:repeat(3,1fr);align-items:start}form.grid:not(.narrow)>button{grid-column:1/-1;justify-self:start}}
@media (max-width:700px){table,thead,tbody,tr,td{display:block}thead{display:none}tr{border-bottom:2px solid var(--line)}td{border:0;padding:4px 10px}}
`;
