// API router: /api/* requests. `getDb` returns a MongoDB Db (or a test double with the same methods).
import { fail, originOk, allowedOrigins, SECURITY_HEADERS } from "./http.js";
import { AUTH_ROUTES } from "./auth.js";
import { PUBLIC_ROUTES } from "./public.js";
import { ADMIN_ROUTES, certificatePublic } from "./admin.js";

const ROUTES = { ...AUTH_ROUTES, ...PUBLIC_ROUTES, "GET /api/certificate": certificatePublic, ...ADMIN_ROUTES };

function withHeaders(res, request, env) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) h.set(k, v);
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins(env).includes(origin)) {   // only listed origins may call the API from a browser
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Credentials", "true");
    h.append("Vary", "Origin");
  }
  return new Response(res.body, { status: res.status, headers: h });
}

export async function handle(request, env, getDb) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (request.method === "OPTIONS") {
    const res = new Response(null, { status: 204, headers: originOk(request, env)
      ? { "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600" } : {} });
    return withHeaders(res, request, env);
  }
  const fn = ROUTES[`${request.method} ${path}`];
  if (!fn) return withHeaders(fail("Not found.", 404), request, env);
  if (request.method === "POST" && !originOk(request, env)) return withHeaders(fail("Requests from other websites are not allowed.", 403), request, env);
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    console.error("SESSION_SECRET is missing or shorter than 32 characters");
    return withHeaders(fail("The website is not fully set up yet. Please try again later.", 503), request, env);
  }
  let db;
  try { db = await getDb(); }
  catch (e) { console.error("Database connection failed", e?.message); return withHeaders(fail("We cannot reach our records right now. Please try again in a minute.", 503), request, env); }
  try {
    return withHeaders(await fn(request, env, db), request, env);
  } catch (e) {
    console.error(e);   // details stay in the Cloudflare logs; visitors only see a plain message
    return withHeaders(fail("Something went wrong on our side. Please try again.", 500), request, env);
  }
}
