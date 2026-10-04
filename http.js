// Shared helpers for every route: responses, sessions (HttpOnly cookie), admins, rate limits, security headers.
import { readToken, hmac } from "./lib.js";

export const SESSION_COOKIE = "gci_session";
export const SESSION_DAYS = 7;

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://res.cloudinary.com",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; "),
};

export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});
export const fail = (message, status = 400, extra = {}) => json({ ok: false, error: message, ...extra }, status);

export async function body(request, limit = 20000) {
  if (Number(request.headers.get("content-length") || 0) > limit) return {};
  try { const b = await request.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : {}; } catch { return {}; }
}

// ---------- session cookie ----------
export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readCookie(request, name) {
  const all = request.headers.get("cookie") || "";
  for (const part of all.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

// Admins come from the ADMINS secret: [{"id":"GCI_ADMIN","name":"...","email":"...","mobile":"..."}]
export function adminList(env) {
  try {
    const a = JSON.parse(env.ADMINS || "[]");
    return Array.isArray(a) ? a.filter((x) => x && x.id).map((x) => ({ ...x, id: String(x.id).trim().toUpperCase() })) : [];
  } catch { return []; }
}

// The logged-in user's token payload, or null. Accepts the session cookie (website) or a Bearer token (API tools).
export async function session(request, env, db) {
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const raw = bearer || readCookie(request, SESSION_COOKIE);
  const t = await readToken(env.SESSION_SECRET, raw);
  if (!t || t.purpose) return null;
  const acc = await db.collection("accounts").findOne({ _id: t.sub }, { projection: { tokenVersion: 1 } });
  if (!acc || (acc.tokenVersion || 0) !== t.tv) return null;
  if (t.role === "admin" && !adminList(env).some((a) => a.id === t.sub)) return null;   // removed admins lose access
  return t;
}

// ---------- origins / CORS ----------
export function allowedOrigins(env) {
  const list = [env.SITE_URL || "https://www.gurucomputerinstitute.com"];
  for (const o of String(env.ALLOWED_ORIGINS || "").split(",")) if (o.trim()) list.push(o.trim());
  return list.map((o) => o.replace(/\/+$/, ""));
}
// true when the request comes from this site, an allowed origin, or a non-browser client (no Origin header)
export function originOk(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { if (new URL(origin).host === new URL(request.url).host) return true; } catch { return false; }
  return allowedOrigins(env).includes(origin);
}

// ---------- rate limiting (stored in MongoDB, keyed by a hash of the visitor's IP) ----------
export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
// Returns null when allowed, or the minutes to wait when the limit is reached.
export async function rateLimit(db, env, request, bucket, max, windowSec) {
  const key = `${bucket}:${(await hmac(env.SESSION_SECRET, "ip:" + clientIp(request))).slice(0, 24)}`;
  const col = db.collection("ratelimits"), now = Date.now();
  const doc = await col.findOne({ _id: key });
  if (!doc || new Date(doc.expireAt).getTime() <= now) {
    await col.updateOne({ _id: key }, { $set: { n: 1, expireAt: new Date(now + windowSec * 1000) } }, { upsert: true });
    return null;
  }
  if (doc.n >= max) return Math.max(1, Math.ceil((new Date(doc.expireAt).getTime() - now) / 60000));
  await col.updateOne({ _id: key }, { $inc: { n: 1 } });
  return null;
}
export const tooMany = (minutes) => fail(`Too many attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`, 429);
