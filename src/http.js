// Small helpers shared by the public and admin routes.
import { readToken } from "./lib.js";

export const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
export const fail = (message, status = 400, extra = {}) => json({ ok: false, error: message, ...extra }, status);

export async function body(request, limit = 20000) {
  if (Number(request.headers.get("content-length") || 0) > limit) return {};
  try { return await request.json(); } catch { return {}; }
}

// Admins come from the ADMINS secret: [{"id":"GCI_ADMIN","name":"...","email":"...","mobile":"..."}]
export function adminList(env) {
  try {
    const a = JSON.parse(env.ADMINS || "[]");
    return Array.isArray(a) ? a.filter((x) => x && x.id).map((x) => ({ ...x, id: String(x.id).trim().toUpperCase() })) : [];
  } catch { return []; }
}

// Returns the logged-in user's token payload, or null.
export async function session(request, env, db) {
  const h = request.headers.get("authorization") || "";
  const t = await readToken(env.SESSION_SECRET, h.replace(/^Bearer\s+/i, ""));
  if (!t || t.purpose) return null;
  const acc = await db.collection("accounts").findOne({ _id: t.sub }, { projection: { tokenVersion: 1 } });
  if (!acc || (acc.tokenVersion || 0) !== t.tv) return null;
  if (t.role === "admin" && !adminList(env).some((a) => a.id === t.sub)) return null;   // removed admins lose access
  return t;
}
