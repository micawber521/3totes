// 3totes.com Worker: serves public/ and handles the contact form.
// The destination email is never exposed to visitors. Submissions are relayed through
// Proton SMTP submission (smtp.protonmail.ch:587, STARTTLS, per-address SMTP token).
//
// Secrets (Cloudflare dashboard -> Worker -> Settings -> Variables and Secrets):
//   CONTACT_EMAIL        where submissions are delivered
//   SMTP_USER            Proton custom-domain address the token belongs to (the sender)
//   SMTP_TOKEN           Proton SMTP token for SMTP_USER
//   SMTP_SERVER          optional, default smtp.protonmail.ch
//   SMTP_PORT            optional, default 587 (STARTTLS); 465 = implicit TLS
//   TURNSTILE_SITE_KEY   optional: enables Cloudflare Turnstile anti-spam
//   TURNSTILE_SECRET     optional: required if TURNSTILE_SITE_KEY is set
import { handleAdmin } from "./src/admin.js";
import { handleBook } from "./src/book.js";
import { sendMail, oneLine, encodeHeader } from "./src/mail.js";

const ALLOWED_ORIGINS = ["https://3totes.com", "https://www.3totes.com"];
const LIMITS = { name: 100, email: 200, message: 5000 };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/contact") return handleContact(request, env);
    if (url.pathname === "/book" || url.pathname === "/book/" || url.pathname.startsWith("/api/book/") || url.pathname === "/api/paypal/webhook"
        || url.pathname.startsWith("/my/") || url.pathname.startsWith("/api/my/")) {
      try { const r = await handleBook(request, env); if (r) return r; }
      catch (e) { console.error("book error:", e && e.stack); return Response.json({ ok: false, msg: "Something went wrong. Please try again." }, { status: 500 }); }
    }
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      try { return await handleAdmin(request, env); }
      catch (e) { console.error("admin error:", e && e.stack); return new Response("Something went wrong.", { status: 500 }); }
    }

    const res = await env.ASSETS.fetch(request);
    if (!(res.headers.get("content-type") || "").includes("text/html")) return res;

    const formReady = env.CONTACT_EMAIL && env.SMTP_USER && env.SMTP_TOKEN;
    const siteKey = (env.TURNSTILE_SITE_KEY || "").trim();
    return new HTMLRewriter()
      .on("#contact", { element(el) { if (!formReady) el.remove(); } })
      .on("#turnstile", {
        element(el) {
          if (!siteKey) { el.remove(); return; }
          el.setAttribute("data-sitekey", siteKey);
        },
      })
      .on("head", {
        element(el) {
          if (siteKey) el.append('<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>', { html: true });
        },
      })
      .transform(res);
  },
};

function reply(status, ok, msg) {
  return Response.json({ ok, msg }, { status, headers: { "Cache-Control": "no-store" } });
}

async function handleContact(request, env) {
  if (request.method !== "POST") return reply(405, false, "Method not allowed");
  if (!ALLOWED_ORIGINS.includes(request.headers.get("Origin") || "")) return reply(403, false, "Forbidden");
  if (!(env.CONTACT_EMAIL && env.SMTP_USER && env.SMTP_TOKEN)) return reply(503, false, "Contact form is not available yet.");

  let form;
  try { form = await request.formData(); } catch { return reply(400, false, "Bad request"); }
  const get = (k) => String(form.get(k) || "").trim();

  // Honeypot: real people never see or fill this field.
  if (get("website")) return reply(200, true, "Thanks, your message was sent.");

  const name = get("name"), email = get("email"), message = get("message");
  if (!name || !email || !message) return reply(400, false, "Please fill in every field.");
  if (name.length > LIMITS.name || email.length > LIMITS.email || message.length > LIMITS.message)
    return reply(400, false, "That message is too long.");
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) return reply(400, false, "Please enter a valid email address.");

  if (env.TURNSTILE_SITE_KEY) {
    const ok = await verifyTurnstile(get("cf-turnstile-response"), env.TURNSTILE_SECRET, request.headers.get("CF-Connecting-IP"));
    if (!ok) return reply(400, false, "Please complete the verification and try again.");
  }

  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    await sendMail(env, {
      to: env.CONTACT_EMAIL.trim(),
      fromName: "3totes.com contact form",
      replyTo: `${encodeHeader(oneLine(name).replace(/[<>"]/g, ""))} <${oneLine(email)}>`,
      subject: "3totes.com contact: " + oneLine(name),
      text: `From: ${name} <${email}>\nIP: ${ip}\n\n${message}\n`,
    });
  } catch (e) {
    console.error("smtp failure:", e && e.message);
    return reply(502, false, "Sorry, the message could not be sent. Please try again later.");
  }
  return reply(200, true, "Thanks, your message was sent.");
}

async function verifyTurnstile(token, secret, ip) {
  if (!token || !secret) return false;
  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (ip) body.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const j = await r.json().catch(() => ({}));
  return j.success === true;
}
