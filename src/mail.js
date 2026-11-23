// Minimal SMTP submission client (Proton). Used by the contact form and booking emails.
//   SMTP_USER   Proton custom-domain address (the sender)
//   SMTP_TOKEN  Proton SMTP token for SMTP_USER
//   SMTP_SERVER optional, default smtp.protonmail.ch
//   SMTP_PORT   optional, default 587 (STARTTLS); 465 = implicit TLS
import { connect } from "cloudflare:sockets";

const enc = new TextEncoder();
export const oneLine = (s) => String(s).replace(/[\r\n]+/g, " ");
const b64 = (s) => { let bin = ""; for (const b of enc.encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
export const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export const mailReady = (env) => Boolean(env.SMTP_USER && env.SMTP_TOKEN);

function buildMessage(env, { to, subject, text, fromName, replyTo }) {
  const from = env.SMTP_USER.trim();
  const body64 = b64(String(text).replace(/\r?\n/g, "\r\n")).replace(/.{1,76}/g, "$&\r\n");
  const domain = from.split("@")[1] || "3totes.com";
  return [
    `From: ${encodeHeader(oneLine(fromName || "Totes Totes Totes"))} <${from}>`,
    `To: <${oneLine(to)}>`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${encodeHeader(oneLine(subject))}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body64,
  ].join("\r\n");
}

class Smtp {
  constructor(socket) { this.attach(socket); }
  attach(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.buf = "";
    this.dec = new TextDecoder();
  }
  async read(expect) {
    // Read one full (possibly multi-line) reply, e.g. "250-..." lines ending with "250 ...".
    for (;;) {
      const lines = this.buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const code = Number(lines[i].slice(0, 3));
          this.buf = lines.slice(i + 1).join("\r\n");
          if (code !== expect) throw new Error(`SMTP expected ${expect}, got ${lines[i].slice(0, 120)}`);
          return;
        }
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("SMTP connection closed");
      this.buf += this.dec.decode(value, { stream: true });
    }
  }
  async cmd(line, expect) {
    await this.writer.write(enc.encode(line + "\r\n"));
    await this.read(expect);
  }
}

// msg: { to, subject, text, fromName?, replyTo? (already-formatted header value) }
export async function sendMail(env, msg) {
  const user = env.SMTP_USER.trim();
  const hostname = (env.SMTP_SERVER || "smtp.protonmail.ch").trim();
  const port = Number((env.SMTP_PORT || "587").trim()) || 587;
  const implicitTls = port === 465;
  const socket = connect({ hostname, port }, { secureTransport: implicitTls ? "on" : "starttls" });
  const s = new Smtp(socket);
  try {
    await s.read(220);
    await s.cmd("EHLO 3totes.com", 250);
    if (!implicitTls) {
      await s.cmd("STARTTLS", 220);
      s.reader.releaseLock();
      s.writer.releaseLock();
      s.attach(socket.startTls());
      await s.cmd("EHLO 3totes.com", 250);
    }
    await s.cmd("AUTH PLAIN " + b64(`\u0000${user}\u0000${env.SMTP_TOKEN.trim()}`), 235);
    await s.cmd(`MAIL FROM:<${user}>`, 250);
    await s.cmd(`RCPT TO:<${oneLine(msg.to).trim()}>`, 250);
    await s.cmd("DATA", 354);
    // Body is base64, so no line can start with "." and no dot-stuffing is needed.
    await s.cmd(buildMessage(env, msg) + "\r\n.", 250);
    await s.cmd("QUIT", 221).catch(() => {});
  } finally {
    try { await s.socket.close(); } catch {}
  }
}

// Fire-and-log: booking emails must never break a booking.
export async function trySend(env, msg) {
  if (!mailReady(env) || !msg.to) return false;
  try { await sendMail(env, msg); return true; }
  catch (e) { console.error("mail failure:", e && e.message); return false; }
}
