// Cloudflare Access verification for /admin. Access blocks unauthenticated visitors at the
// edge; this re-checks the signed JWT inside the Worker so a misconfigured Access policy can
// never expose the admin pages. If Access is not configured, admin is closed (fail closed).
//
// Secrets / variables:
//   ACCESS_TEAM_DOMAIN   e.g. yourteam.cloudflareaccess.com
//   ACCESS_AUD           Application Audience (AUD) tag from the Access application
//   OWNER_EMAILS         comma-separated: full admin
//   DRIVER_EMAILS        comma-separated, optional: schedule + check-in only

let certCache = { at: 0, team: "", keys: [] };

const b64urlBytes = (s) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
const emailList = (v) => String(v || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

async function accessKeys(team) {
  if (certCache.team === team && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`access certs ${r.status}`);
  const { keys = [] } = await r.json();
  certCache = { at: Date.now(), team, keys };
  return keys;
}

// Returns { email, role } or { error } where error is a short reason (never shown with details).
export async function adminIdentity(request, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = String(env.ACCESS_AUD || "").trim();
  if (!team || !aud) return { error: "not-configured" };

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { error: "no-token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { error: "bad-token" };

  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch { return { error: "bad-token" }; }
  if (header.alg !== "RS256") return { error: "bad-token" };

  let keys;
  try { keys = await accessKeys(team); } catch { return { error: "certs-unavailable" }; }
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { certCache.at = 0; keys = await accessKeys(team).catch(() => []); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) return { error: "unknown-key" };

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return { error: "bad-signature" };

  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { error: "wrong-aud" };
  if (payload.iss !== `https://${team}`) return { error: "wrong-iss" };
  if (!payload.exp || payload.exp < now) return { error: "expired" };
  if (payload.nbf && payload.nbf > now + 60) return { error: "not-yet-valid" };

  const email = String(payload.email || "").toLowerCase();
  if (emailList(env.OWNER_EMAILS).includes(email)) return { email, role: "owner" };
  if (emailList(env.DRIVER_EMAILS).includes(email)) return { email, role: "driver" };
  return { error: "not-allowed" };
}
