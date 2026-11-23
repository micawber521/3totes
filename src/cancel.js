// Booking cancellation before delivery (policy 2026-11-23):
//   cancel_cutoff_days (5) or more days before delivery → cancel_fee_early ($10)
//   fewer than that                                    → cancel_fee_late ($25)
// Everything else paid at booking (deposit + first period + delivery) is refunded.
// Customers can cancel online until the day before delivery; Christian can cancel anytime from admin.
import { paypalReady, cancelSubscription, refundSale, paypal } from "./paypal.js";
import { trySend } from "./mail.js";

const money = (c) => "$" + (Number(c || 0) / 100).toFixed(2);
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
const niceDate = (ymd) => new Date(ymd + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

export function cancelFee(s, deliveryDate, today) {
  const days = daysBetween(today, deliveryDate);
  const cutoff = Number(s.cancel_cutoff_days ?? 5);
  const early = days >= cutoff;
  return { days, early, cutoff, fee: Number(early ? s.cancel_fee_early_cents ?? 1000 : s.cancel_fee_late_cents ?? 2500) };
}

// Customer-cancellable: paid, not delivered, and delivery is still in the future.
export const customerCanCancel = (b, today) => b.status === "confirmed" && b.delivery_date > today;

// The booking payment (setup fee sale). Falls back to asking PayPal if the webhook hasn't recorded it yet.
async function setupSale(env, db, b) {
  const row = await db.prepare("SELECT paypal_id, amount_cents FROM payments WHERE booking_id = ? AND kind = 'setup'").bind(b.id).first();
  if (row) return row;
  if (!b.paypal_subscription_id) return null;
  const start = new Date(Date.parse(b.created_at.replace(" ", "T") + "Z") - 86400000).toISOString();
  const end = new Date(Date.now() + 86400000).toISOString();
  const r = await paypal(env, "GET", `/v1/billing/subscriptions/${encodeURIComponent(b.paypal_subscription_id)}/transactions?start_time=${start}&end_time=${end}`);
  const t = r.ok && (r.data.transactions || []).find((x) => x.status === "COMPLETED");
  if (!t) return null;
  const cents = Math.round(Number(t.amount_with_breakdown?.gross_amount?.value || 0) * 100);
  await db.prepare("INSERT OR IGNORE INTO payments (booking_id, kind, amount_cents, paypal_id, status) VALUES (?, 'setup', ?, ?, 'completed')")
    .bind(b.id, cents, t.id).run();
  return { paypal_id: t.id, amount_cents: cents };
}

// Returns { ok, msg, refunded, fee }.
export async function cancelBooking(env, db, b, { fee, by }) {
  const log = (detail) => db.prepare("INSERT INTO booking_events (booking_id, by_email, action, detail) VALUES (?, ?, 'cancelled', ?)").bind(b.id, by, detail).run();
  let refunded = 0;
  if (b.paypal_subscription_id) {
    if (!paypalReady(env)) return { ok: false, msg: "Payments are unavailable right now. Please contact us." };
    const sale = await setupSale(env, db, b);
    if (!sale) return { ok: false, msg: "We couldn't find the booking payment yet. Please try again in a few minutes or contact us." };
    const refundable = sale.amount_cents - (await db.prepare("SELECT COALESCE(SUM(amount_cents), 0) s FROM payments WHERE kind = 'refund' AND refund_of = ?").bind(sale.paypal_id).first()).s;
    const amount = Math.max(0, refundable - fee);
    const c = await cancelSubscription(env, b.paypal_subscription_id, `Booking ${b.id} cancelled before delivery`);
    if (!c.ok && c.status !== 422) return { ok: false, msg: "PayPal didn't accept the cancellation. Please try again or contact us." };
    await db.prepare("UPDATE bookings SET billing_status = 'CANCELLED' WHERE id = ?").bind(b.id).run();
    if (amount > 0) {
      const r = await refundSale(env, sale.paypal_id, amount);
      if (!r.ok) {
        await log(`billing stopped, but PayPal refused the ${money(amount)} refund (${r.status}); refund manually`);
        return { ok: false, msg: "Your booking billing was stopped, but the refund didn't go through. We'll take care of it and email you." };
      }
      await db.prepare("INSERT OR IGNORE INTO payments (booking_id, kind, amount_cents, paypal_id, status, refund_of) VALUES (?, 'refund', ?, ?, ?, ?)")
        .bind(b.id, amount, r.data.id || null, r.data.state || "completed", sale.paypal_id).run();
      refunded = amount;
    }
  }
  await db.prepare(`UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL, deposit_refunded_cents = deposit_cents,
      deposit_settled_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(b.id).run();
  await log(`cancellation fee ${money(fee)}${b.paypal_subscription_id ? `, refunded ${money(refunded)} via PayPal` : " (manual booking: settle outside PayPal)"}`);

  const owner = String(env.CONTACT_EMAIL || "").trim();
  if (b.email) await trySend(env, {
    to: b.email, subject: `Booking #${b.id} cancelled`, replyTo: owner ? `<${owner}>` : undefined,
    text: `Hi ${b.name},\n\nYour tote rental for ${niceDate(b.delivery_date)} is cancelled.\n\nCancellation fee: ${money(fee)}\n${b.paypal_subscription_id ? `Refunded: ${money(refunded)} (deposit, first rental period and any delivery fee, minus the fee)\n\nRefunds go back to the payment method you used through PayPal. Your bank may take a few business days to show it.` : ""}\n\nWe hope to help with your next move!\nTotes Totes Totes\n3totes.com\n`,
  });
  if (owner) await trySend(env, {
    to: owner, fromName: "3totes bookings", subject: `Cancelled: booking #${b.id}, ${b.name} (${b.delivery_date})`,
    text: `Booking #${b.id} for ${niceDate(b.delivery_date)} was cancelled by ${by}.\nFee kept: ${money(fee)}\nRefunded: ${money(refunded)}\n\nhttps://3totes.com/admin/bookings/${b.id}\n`,
  });
  return { ok: true, msg: `Booking cancelled. ${refunded ? `${money(refunded)} is on its way back to you.` : ""}`.trim(), refunded, fee };
}

export function cancelPolicyText(s) {
  const d = Number(s.cancel_cutoff_days ?? 5);
  return `Cancel ${d} or more days before delivery for a ${money(s.cancel_fee_early_cents ?? 1000)} fee, or less than ${d} days before for a ${money(s.cancel_fee_late_cents ?? 2500)} fee. Everything else you paid comes back.`;
}
