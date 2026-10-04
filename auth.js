// Login for students, franchise centres and admins:
// Enrollment ID -> (first time / forgot) code on WhatsApp + email -> create password -> logged in (HttpOnly cookie).
import {
  hashPassword, verifyPassword, passwordProblem, signToken, readToken, newOtp, otpHash,
  randomId, sendEmail, otpEmail, maskEmail, cleanId, str, whatsappReady, sendWhatsAppOtp, indianMobile, maskPhone,
} from "./lib.js";
import { json, fail, body, session, adminList, sessionCookie, clearCookie, SESSION_DAYS, rateLimit, tooMany } from "./http.js";

const OTP_TTL = 10 * 60 * 1000;                          // a code is valid for 10 minutes
const OTP_MAX_TRIES = 5;                                 // wrong guesses before a new code is needed
const OTP_MAX_SENDS = 3, OTP_WINDOW = 30 * 60 * 1000;    // 3 codes per 30 minutes per ID
const LOGIN_MAX_FAILS = 5, LOCK_TIME = 15 * 60 * 1000;   // lock 15 minutes after 5 wrong passwords
const SETUP_TTL = 15 * 60 * 1000;                        // time allowed to create a password after the code
const ID_RE = /^[A-Z0-9_-]{3,30}$/;

const accounts = (db) => db.collection("accounts");
export const homeFor = (role) => (role === "admin" ? "/admin" : "/dashboard");

async function findPerson(db, id, env) {
  const admin = adminList(env).find((a) => a.id === id);
  if (admin) return { role: "admin", id, name: str(admin.name || "Admin"), email: str(admin.email, 200), phone: indianMobile(admin.mobile) };
  if (/^GCIFRN\d+$/.test(id)) {
    const f = await db.collection("franchises").findOne({ _id: id }, { projection: { name: 1, email: 1, mobileNo: 1, "director.name": 1 } });
    return f ? { role: "franchise", id, name: str(f.director?.name || f.name), email: str(f.email, 200), phone: indianMobile(f.mobileNo) } : null;
  }
  const s = await db.collection("students").findOne({ _id: id }, { projection: { name: 1, email: 1, mobileNo: 1 } });
  return s ? { role: "student", id, name: str(s.name), email: str(s.email, 200), phone: indianMobile(s.mobileNo) } : null;
}

async function sendOtp(env, db, person, purpose) {
  const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(person.email || "");
  const hasWa = !!(person.phone && whatsappReady(env));
  if (!hasEmail && !hasWa) return fail("No email address or mobile number is saved for this ID. Please contact the institute to add it.", 422);
  const now = Date.now();
  const acc = (await accounts(db).findOne({ _id: person.id })) || {};
  const recent = (acc.otpSends || []).filter((t) => now - t < OTP_WINDOW);
  if (recent.length >= OTP_MAX_SENDS) {
    const wait = Math.ceil((OTP_WINDOW - (now - recent[0])) / 60000);
    return fail(`Too many codes requested. Please try again in ${wait} minutes.`, 429);
  }
  const otp = newOtp();
  await accounts(db).updateOne({ _id: person.id }, {
    $set: { role: person.role, updatedAt: new Date(now), otpSends: [...recent, now],
      otp: { hash: await otpHash(env.SESSION_SECRET, person.id, otp), expiresAt: now + OTP_TTL, tries: 0, purpose } },
    $setOnInsert: { createdAt: new Date(now), tokenVersion: 0 },
  }, { upsert: true });
  const jobs = [];
  if (hasWa) jobs.push({ via: "WhatsApp", to: maskPhone(person.phone), run: () => sendWhatsAppOtp(env, person.phone, otp) });
  if (hasEmail) {
    const mail = otpEmail(person.name || "Student", otp, purpose);
    jobs.push({ via: "email", to: maskEmail(person.email), run: () => sendEmail(env, { to: person.email, toName: person.name, ...mail }) });
  }
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  results.forEach((r, i) => { if (r.status === "rejected") console.error(`OTP ${jobs[i].via} failed`, r.reason?.message); });
  const sent = jobs.filter((j, i) => results[i].status === "fulfilled");
  if (!sent.length) return fail("We could not send the code right now. Please try again in a few minutes.", 502);
  return json({ ok: true, next: "otp", sentVia: sent.map((j) => ({ via: j.via, to: j.to })), sentTo: sent.map((j) => `${j.via} ${j.to}`).join(" and "),
    ...(env.DEV_SHOW_OTP === "1" ? { devOtp: otp } : {}) });   // DEV_SHOW_OTP is for local testing only
}

async function newSession(env, id, role, tv) {
  const token = await signToken(env.SESSION_SECRET, { sub: id, role, tv, exp: Date.now() + SESSION_DAYS * 86400000 });
  return json({ ok: true, role, redirect: homeFor(role) }, 200, { "set-cookie": sessionCookie(token) });
}

// POST /api/auth/start {id}: asks for the password, or sends a code the first time
async function start(request, env, db) {
  const wait = await rateLimit(db, env, request, "auth-start", 20, 600);
  if (wait) return tooMany(wait);
  const id = cleanId((await body(request)).id);
  if (!id) return fail("Enter your Enrollment ID.");
  if (!ID_RE.test(id)) return fail("This does not look like an Enrollment ID. It looks like GCI2022001.");
  const person = await findPerson(db, id, env);
  if (!person) return fail("No student or centre found with this ID. Check the ID on your admission slip.", 404);
  const acc = await accounts(db).findOne({ _id: id }, { projection: { passwordHash: 1 } });
  if (acc?.passwordHash) return json({ ok: true, next: "password", name: person.name.split(" ")[0] });
  return sendOtp(env, db, person, "setup");
}

// POST /api/auth/forgot {id}
async function forgot(request, env, db) {
  const wait = await rateLimit(db, env, request, "auth-start", 20, 600);
  if (wait) return tooMany(wait);
  const id = cleanId((await body(request)).id);
  const person = ID_RE.test(id) && (await findPerson(db, id, env));
  if (!person) return fail("No student or centre found with this ID.", 404);
  return sendOtp(env, db, person, "reset");
}

// POST /api/auth/verify-otp {id, otp}: short-lived token that allows creating a password
async function verifyOtp(request, env, db) {
  const wait = await rateLimit(db, env, request, "auth-otp", 30, 600);
  if (wait) return tooMany(wait);
  const b = await body(request);
  const id = cleanId(b.id), otp = String(b.otp || "").replace(/\D/g, "");
  if (!id || otp.length !== 6) return fail("Enter the 6-digit code we sent you.");
  const acc = await accounts(db).findOne({ _id: id });
  const o = acc?.otp;
  if (!o?.hash) return fail("Please request a new code.");
  if (o.expiresAt < Date.now()) return fail("This code has expired. Please request a new one.");
  if (o.tries >= OTP_MAX_TRIES) return fail("Too many wrong codes. Please request a new one.", 429);
  if ((await otpHash(env.SESSION_SECRET, id, otp)) !== o.hash) {
    await accounts(db).updateOne({ _id: id }, { $inc: { "otp.tries": 1 } });
    const left = OTP_MAX_TRIES - (o.tries + 1);
    return fail(left > 0 ? `Wrong code. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Please request a new one.");
  }
  const nonce = randomId();
  await accounts(db).updateOne({ _id: id }, { $set: { setupNonce: nonce, updatedAt: new Date() }, $unset: { otp: "" } });
  return json({ ok: true, setupToken: await signToken(env.SESSION_SECRET, { sub: id, role: acc.role, purpose: "setpw", n: nonce, exp: Date.now() + SETUP_TTL }) });
}

// POST /api/auth/set-password {setupToken, password}
async function setPassword(request, env, db) {
  const b = await body(request);
  const t = await readToken(env.SESSION_SECRET, b.setupToken);
  if (!t || t.purpose !== "setpw") return fail("Your verification has expired. Please start again.", 401);
  const problem = passwordProblem(b.password);
  if (problem) return fail(problem);
  const acc = await accounts(db).findOne({ _id: t.sub });
  if (!acc || acc.setupNonce !== t.n) return fail("This code was already used. Please start again.", 401);
  const tokenVersion = (acc.tokenVersion || 0) + 1;   // a new password logs out every old session
  await accounts(db).updateOne({ _id: t.sub }, {
    $set: { passwordHash: await hashPassword(b.password), passwordSetAt: new Date(), tokenVersion, failedLogins: 0, updatedAt: new Date() },
    $unset: { setupNonce: "", lockUntil: "" },
  });
  return newSession(env, t.sub, acc.role, tokenVersion);
}

// POST /api/auth/login {id, password}
async function login(request, env, db) {
  const wait = await rateLimit(db, env, request, "auth-login", 30, 600);
  if (wait) return tooMany(wait);
  const b = await body(request);
  const id = cleanId(b.id);
  if (!id || typeof b.password !== "string" || !b.password) return fail("Enter your Enrollment ID and password.");
  const acc = await accounts(db).findOne({ _id: id });
  if (!acc?.passwordHash) return fail("Incorrect ID or password.", 401);
  if (acc.role === "admin" && !adminList(env).some((a) => a.id === id)) return fail("Incorrect ID or password.", 401);
  if (acc.lockUntil && acc.lockUntil > Date.now()) {
    return fail(`Too many wrong attempts. Try again in ${Math.ceil((acc.lockUntil - Date.now()) / 60000)} minutes, or use "Forgot password".`, 429);
  }
  if (!(await verifyPassword(b.password, acc.passwordHash))) {
    const fails = (acc.failedLogins || 0) + 1;
    const locked = fails >= LOGIN_MAX_FAILS;
    await accounts(db).updateOne({ _id: id }, { $set: locked ? { failedLogins: 0, lockUntil: Date.now() + LOCK_TIME } : { failedLogins: fails } });
    return fail(locked ? 'Too many wrong attempts. Try again in 15 minutes, or use "Forgot password".' : "Incorrect ID or password.", locked ? 429 : 401);
  }
  await accounts(db).updateOne({ _id: id }, { $set: { failedLogins: 0, lastLoginAt: new Date() }, $unset: { lockUntil: "" } });
  return newSession(env, id, acc.role, acc.tokenVersion || 0);
}

// POST /api/auth/logout: ends this session and every other session of this account
async function logout(request, env, db) {
  const s = await session(request, env, db);
  if (s) await accounts(db).updateOne({ _id: s.sub }, { $inc: { tokenVersion: 1 } });
  return json({ ok: true }, 200, { "set-cookie": clearCookie() });
}

export const AUTH_ROUTES = {
  "POST /api/auth/start": start,
  "POST /api/auth/forgot": forgot,
  "POST /api/auth/verify-otp": verifyOtp,
  "POST /api/auth/set-password": setPassword,
  "POST /api/auth/login": login,
  "POST /api/auth/logout": logout,
};
