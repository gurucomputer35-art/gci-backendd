// Shared helpers: passwords, signed tokens, OTPs, email, validation.
// Uses only Web Crypto and fetch, so it runs on Cloudflare Workers (and Node 20+ for tests).

const enc = new TextEncoder();

export const b64u = {
  enc(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- passwords (PBKDF2-SHA256, 100k iterations: the Workers maximum) ----------
const PBKDF2_ITER = 100000;

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64u.enc(salt)}$${b64u.enc(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || "").split("$");
  if (alg !== "pbkdf2") return false;
  const got = await pbkdf2(password, b64u.dec(salt), Number(iter));
  return timingSafeEqual(b64u.enc(got), hash);
}

export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 72) return "Password must be 72 characters or fewer.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain at least one letter and one number.";
  return null;
}

// ---------- HMAC helpers and signed tokens ----------
async function hmacKey(secret) {
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be set (at least 32 characters).");
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmac(secret, data) {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data));
  return b64u.enc(sig);
}

export async function signToken(secret, payload) {
  const body = b64u.enc(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function readToken(secret, token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!timingSafeEqual(await hmac(secret, body), sig || "")) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(b64u.dec(body))); } catch { return null; }
  if (!p || typeof p.exp !== "number" || p.exp < Date.now()) return null;
  return p;
}

// ---------- OTP ----------
export function newOtp() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, "0");
}
export const otpHash = (secret, id, otp) => hmac(secret, `otp:${id}:${otp}`);
export function randomId(len = 16) { return b64u.enc(crypto.getRandomValues(new Uint8Array(len))); }

// ---------- email (Brevo or Resend, chosen by which key is set) ----------
export async function sendEmail(env, { to, toName, subject, html, text }) {
  const from = env.MAIL_FROM, fromName = env.MAIL_FROM_NAME || "Guru Computer Institute";
  if (!from) throw new Error("MAIL_FROM is not set.");
  let res;
  if (env.BREVO_API_KEY) {
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: { email: from, name: fromName }, to: [{ email: to, name: toName || to }], subject, htmlContent: html, textContent: text }),
    });
  } else if (env.RESEND_API_KEY) {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: `${fromName} <${from}>`, to: [to], subject, html, text }),
    });
  } else {
    throw new Error("No email service configured (set BREVO_API_KEY or RESEND_API_KEY).");
  }
  if (!res.ok) throw new Error(`Email service error ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ---------- WhatsApp OTP (Meta WhatsApp Cloud API, approved AUTHENTICATION template) ----------
export const whatsappReady = (env) => !!(env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID && env.WA_OTP_TEMPLATE);

export async function sendWhatsAppOtp(env, phone10, otp) {
  const version = env.WA_API_VERSION || "v23.0";
  const components = [{ type: "body", parameters: [{ type: "text", text: otp }] }];
  // Authentication templates with a "Copy code" button need the code in the button too.
  if (env.WA_OTP_BUTTON !== "0") components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: otp }] });
  const res = await fetch(`https://graph.facebook.com/${version}/${env.WA_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", recipient_type: "individual", to: `91${phone10}`, type: "template",
      template: { name: env.WA_OTP_TEMPLATE, language: { code: env.WA_OTP_LANG || "en" }, components },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export const indianMobile = (v) => { const d = String(v || "").replace(/\D/g, "").slice(-10); return /^[6-9]\d{9}$/.test(d) ? d : ""; };
export const maskPhone = (p) => (p ? "******" + p.slice(-4) : "");

export function otpEmail(name, otp, purpose) {
  const action = purpose === "reset" ? "reset your password" : "set up your login";
  const text = `Hello ${name},\n\nYour Guru Computer Institute verification code is ${otp}.\nUse it to ${action}. It expires in 10 minutes.\n\nIf you did not ask for this, ignore this email.`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#14254a">
<h2 style="margin:0 0 12px">Guru Computer Institute</h2>
<p>Hello ${escapeHtml(name)},</p>
<p>Use this code to ${action}:</p>
<p style="font-size:30px;letter-spacing:8px;font-weight:bold;background:#f6f8fb;padding:14px 18px;border-radius:8px;display:inline-block">${otp}</p>
<p>It expires in 10 minutes. If you did not ask for this, ignore this email.</p>
<p style="color:#56627a;font-size:13px">Raja Ka Tajpur, Bijnor · +91 93898 24310</p></div>`;
  return { subject: `${otp} is your Guru Computer Institute code`, text, html };
}

// ---------- Cloudinary (private "authenticated" uploads) ----------
export const cloudinaryReady = (env) => !!(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

async function sha1Hex(text) {
  const d = await crypto.subtle.digest("SHA-1", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// file = { mime: "image/jpeg" | "image/png" | "application/pdf", data: base64 }
export async function uploadPrivate(env, file, folder, publicId) {
  if (!file || !file.data) return "";
  if (!["image/jpeg", "image/png", "application/pdf"].includes(file.mime)) throw new Error("Only JPG, PNG or PDF files can be uploaded.");
  if (file.data.length > 4_000_000) throw new Error("Each file must be under 3 MB.");
  const params = { folder, overwrite: "true", public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)), type: "authenticated" };
  const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  const form = new FormData();
  for (const [k, v] of Object.entries(params)) form.append(k, v);
  form.append("api_key", env.CLOUDINARY_API_KEY);
  form.append("signature", await sha1Hex(toSign + env.CLOUDINARY_API_SECRET));
  form.append("file", `data:${file.mime};base64,${file.data}`);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/image/upload`, { method: "POST", body: form });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.secure_url) throw new Error(`Upload failed: ${out.error?.message || res.status}`);
  return out.secure_url;   // signed URL, opens only with the signature it contains
}

export function randomCode(len = 6) {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O/1/I, easier to read on paper
  const r = crypto.getRandomValues(new Uint8Array(len));
  return [...r].map((x) => abc[x % abc.length]).join("");
}
export const hex24 = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- small utilities ----------
export function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
export function maskEmail(e) {
  const [u, d] = String(e || "").split("@");
  if (!u || !d) return "";
  return (u.length <= 2 ? u[0] + "*" : u[0] + "*".repeat(Math.min(6, u.length - 2)) + u.slice(-1)) + "@" + d;
}
export const num = (v) => Number(String(v ?? "").replace(/[^\d.]/g, "")) || 0;
export const cleanId = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "").slice(0, 30);
export const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
export function fmtDuration(d) {
  if (!d || !d.value) return "";
  const v = String(d.value), t = String(d.type || "Month").toLowerCase();
  return `${v} ${t}${v === "1" ? "" : "s"}`;
}
