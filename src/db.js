// D1 schema + migrations. The Worker applies pending migrations itself on the first
// admin request after a deploy, so no wrangler login is needed to set up the database.
// Each migration is a list of single statements (run together in one D1 batch = one transaction).
// Never edit a released migration; add a new one.

const MIGRATIONS = [
  [1, [
    `CREATE TABLE IF NOT EXISTS kits (
       id INTEGER PRIMARY KEY,
       label TEXT NOT NULL UNIQUE,
       status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cleaning','retired')),
       notes TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS customers (
       id INTEGER PRIMARY KEY,
       name TEXT NOT NULL,
       email TEXT,
       phone TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS customers_email ON customers (email)`,
    `CREATE TABLE IF NOT EXISTS bookings (
       id INTEGER PRIMARY KEY,
       customer_id INTEGER NOT NULL REFERENCES customers (id),
       kit_id INTEGER NOT NULL REFERENCES kits (id),
       plan TEXT NOT NULL CHECK (plan IN ('moving','storage')),
       status TEXT NOT NULL DEFAULT 'confirmed'
         CHECK (status IN ('pending','confirmed','delivered','pickup_requested','returned','closed','cancelled')),
       address TEXT NOT NULL,
       zip TEXT NOT NULL,
       delivery_date TEXT NOT NULL,        -- YYYY-MM-DD; drop-off is first thing that morning
       pickup_date TEXT,                   -- NULL = open-ended
       notes TEXT,
       discount_code TEXT,
       agreement_version TEXT,
       signed_name TEXT,
       signed_at TEXT,
       signed_ip TEXT,
       paypal_order_id TEXT,
       paypal_subscription_id TEXT,
       deposit_cents INTEGER NOT NULL DEFAULT 0,
       deposit_refunded_cents INTEGER NOT NULL DEFAULT 0,
       source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','online')),
       created_at TEXT NOT NULL DEFAULT (datetime('now')),
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS bookings_kit ON bookings (kit_id, delivery_date)`,
    `CREATE INDEX IF NOT EXISTS bookings_status ON bookings (status)`,
    `CREATE TABLE IF NOT EXISTS booking_events (
       id INTEGER PRIMARY KEY,
       booking_id INTEGER NOT NULL REFERENCES bookings (id),
       at TEXT NOT NULL DEFAULT (datetime('now')),
       by_email TEXT,
       action TEXT NOT NULL,
       detail TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS booking_events_booking ON booking_events (booking_id)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `INSERT OR IGNORE INTO kits (label, notes) VALUES ('K01', 'First kit, built 2026-11-23')`,
    // DRAFT prices from the 2026-11-06 planning session; edit on the Settings page.
    `INSERT OR IGNORE INTO settings (key, value) VALUES
       ('deposit_cents', '10000'),
       ('moving_first_cents', '6500'),
       ('moving_weekly_cents', '2000'),
       ('storage_monthly_cents', '10000'),
       ('buffer_days', '1'),
       ('agreement_version', 'draft-2026-11-23')`,
  ]],
  [2, [
    `ALTER TABLE bookings ADD COLUMN hold_expires_at TEXT`,          // unpaid online booking: kit held until then
    `ALTER TABLE bookings ADD COLUMN delivery_fee_cents INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN rate_first_cents INTEGER`,       // price snapshot at booking time
    `ALTER TABLE bookings ADD COLUMN rate_recurring_cents INTEGER`,
    `ALTER TABLE bookings ADD COLUMN paypal_plan_id TEXT`,
    `ALTER TABLE bookings ADD COLUMN billing_status TEXT`,            // PayPal subscription status as last seen
    `CREATE UNIQUE INDEX IF NOT EXISTS bookings_subscription ON bookings (paypal_subscription_id) WHERE paypal_subscription_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS zones (
       zip TEXT PRIMARY KEY,
       zone TEXT NOT NULL,
       delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
       hub TEXT NOT NULL DEFAULT 'sikeston'
     )`,
    `CREATE TABLE IF NOT EXISTS payments (
       id INTEGER PRIMARY KEY,
       booking_id INTEGER NOT NULL REFERENCES bookings (id),
       kind TEXT NOT NULL CHECK (kind IN ('setup','rental','refund','other')),
       amount_cents INTEGER NOT NULL,
       paypal_id TEXT UNIQUE,
       status TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE INDEX IF NOT EXISTS payments_booking ON payments (booking_id)`,
    `CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, type TEXT, received_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS waitlist (id INTEGER PRIMARY KEY, email TEXT NOT NULL, zip TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    `INSERT OR IGNORE INTO settings (key, value) VALUES
       ('online_booking', 'off'),
       ('booking_preview_key', lower(hex(randomblob(12)))),
       ('lead_days', '1'),
       ('agreement_text', '')`,
  ]],
  [3, [
    `ALTER TABLE bookings ADD COLUMN est_return_date TEXT`,   // customer's estimate; informational only, never frees the kit
    `ALTER TABLE bookings ADD COLUMN manage_token TEXT`,      // private customer link /my/<token>
    `UPDATE bookings SET manage_token = lower(hex(randomblob(24))) WHERE manage_token IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS bookings_manage_token ON bookings (manage_token)`,
  ]],
  [4, [
    `ALTER TABLE payments ADD COLUMN refund_of TEXT`,  // PayPal sale id a refund came out of
    `UPDATE payments SET refund_of = (SELECT p2.paypal_id FROM payments p2 WHERE p2.booking_id = payments.booking_id AND p2.kind = 'setup')
      WHERE kind = 'refund' AND refund_of IS NULL`,
  ]],
  [5, [
    `ALTER TABLE bookings ADD COLUMN deposit_kept_cents INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE bookings ADD COLUMN deposit_kept_reason TEXT`,
    `ALTER TABLE bookings ADD COLUMN deposit_settled_at TEXT`,   // when the deposit was refunded/settled
    `ALTER TABLE bookings ADD COLUMN returned_at TEXT`,          // when pickup was completed
  ]],
];

let ready = false;

export async function ensureSchema(db) {
  if (ready) return;
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  const row = await db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM _migrations").first();
  for (const [version, stmts] of MIGRATIONS) {
    if (version <= row.v) continue;
    try {
      await db.batch([
        ...stmts.map((s) => db.prepare(s)),
        db.prepare("INSERT INTO _migrations (version) VALUES (?)").bind(version),
      ]);
    } catch (e) {
      // Another isolate may have applied it at the same moment; only rethrow if it is still missing.
      const done = await db.prepare("SELECT 1 FROM _migrations WHERE version = ?").bind(version).first();
      if (!done) throw e;
    }
  }
  ready = true;
}

export async function getSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

// Does kitId have another booking that overlaps [start, end]? end = null means open-ended.
// A booking blocks its kit from delivery_date through pickup_date + buffer days (cleaning/turnaround).
export async function kitConflict(db, { kitId, start, end, bufferDays, excludeId = 0 }) {
  const buf = `+${Number(bufferDays) || 0} days`;
  return db.prepare(
    `SELECT b.id, b.delivery_date, b.pickup_date, c.name
       FROM bookings b JOIN customers c ON c.id = b.customer_id
      WHERE b.kit_id = ?1 AND b.id != ?2 AND b.status != 'cancelled'
        AND NOT (b.status = 'pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at < datetime('now'))
        AND (b.pickup_date IS NULL OR date(b.pickup_date, ?3) >= ?4)
        AND (?5 IS NULL OR b.delivery_date <= date(?5, ?3))
      LIMIT 1`
  ).bind(kitId, excludeId, buf, start, end).first();
}

// Blocks per kit for the public calendar: [{kitId, start, end|null}] with buffer already added to end.
export async function kitBlocks(db, bufferDays) {
  const buf = `+${Number(bufferDays) || 0} days`;
  const kits = (await db.prepare("SELECT id FROM kits WHERE status = 'active' ORDER BY label").all()).results.map((k) => k.id);
  const { results } = await db.prepare(
    `SELECT kit_id, delivery_date AS start, CASE WHEN pickup_date IS NULL THEN NULL ELSE date(pickup_date, ?1) END AS end
       FROM bookings
      WHERE status != 'cancelled'
        AND NOT (status = 'pending' AND hold_expires_at IS NOT NULL AND hold_expires_at < datetime('now'))`
  ).bind(buf).all();
  return { kits, blocks: results };
}

// First kit free for [start, end] (inclusive dates; end may be null = open-ended).
export function freeKit({ kits, blocks }, start, end) {
  for (const k of kits) {
    const clash = blocks.some((b) => b.kit_id === k && (b.end === null || b.end >= start) && (end === null || b.start <= end));
    if (!clash) return k;
  }
  return null;
}

export const newToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, "0")).join("");
