// All API routes. `db` is a MongoDB Db (or a test double with the same methods).
import {
  hashPassword, verifyPassword, passwordProblem, signToken, readToken, newOtp, otpHash,
  randomId, sendEmail, otpEmail, maskEmail, num, cleanId, str, fmtDuration,
  whatsappReady, sendWhatsAppOtp, indianMobile, maskPhone,
} from "./lib.js";
import { json, fail, body, session, adminList } from "./http.js";
import { ADMIN_ROUTES, certificatePublic } from "./admin.js";

const OTP_TTL = 10 * 60 * 1000;          // OTP valid for 10 minutes
const OTP_MAX_TRIES = 5;                  // wrong OTP guesses before a new code is needed
const OTP_MAX_SENDS = 3, OTP_WINDOW = 30 * 60 * 1000;   // 3 emails per 30 minutes per ID
const LOGIN_MAX_FAILS = 5, LOCK_TIME = 15 * 60 * 1000;  // lock 15 min after 5 wrong passwords
const SESSION_TTL = 7 * 24 * 3600 * 1000;               // stay logged in for 7 days
const SETUP_TTL = 15 * 60 * 1000;                       // time to create a password after OTP


// ---------- who is this ID? ----------
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

const accounts = (db) => db.collection("accounts");

async function sendOtp(env, db, person, purpose) {
  const hasEmail = !!(person.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(person.email));
  const hasWa = !!(person.phone && whatsappReady(env));
  if (!hasEmail && !hasWa) {
    return fail("No email address or mobile number is saved for this ID. Please contact the institute to add it.", 422);
  }
  const now = Date.now();
  const acc = (await accounts(db).findOne({ _id: person.id })) || {};
  const recent = (acc.otpSends || []).filter((t) => now - t < OTP_WINDOW);   // kept outside "otp" so verifying does not reset it
  if (recent.length >= OTP_MAX_SENDS) {
    const wait = Math.ceil((OTP_WINDOW - (now - recent[0])) / 60000);
    return fail(`Too many codes requested. Please try again in ${wait} minutes.`, 429);
  }
  const otp = newOtp();
  await accounts(db).updateOne({ _id: person.id }, {
    $set: {
      role: person.role, updatedAt: new Date(now),
      otp: { hash: await otpHash(env.SESSION_SECRET, person.id, otp), expiresAt: now + OTP_TTL, tries: 0, purpose },
      otpSends: [...recent, now],
    },
    $setOnInsert: { createdAt: new Date(now), tokenVersion: 0 },
  }, { upsert: true });
  // Send on WhatsApp and email at the same time; it is enough if one of them arrives.
  const jobs = [];
  if (hasWa) jobs.push({ via: "WhatsApp", to: maskPhone(person.phone), run: () => sendWhatsAppOtp(env, person.phone, otp) });
  if (hasEmail) {
    const mail = otpEmail(person.name || "Student", otp, purpose);
    jobs.push({ via: "email", to: maskEmail(person.email), run: () => sendEmail(env, { to: person.email, toName: person.name, ...mail }) });
  }
  const results = await Promise.allSettled(jobs.map((j) => j.run()));
  const sent = jobs.filter((j, i) => results[i].status === "fulfilled");
  results.forEach((r, i) => { if (r.status === "rejected") console.error(`OTP ${jobs[i].via} failed`, r.reason?.message); });
  if (!sent.length) return fail("We could not send the code right now. Please try again in a few minutes.", 502);
  const extra = env.DEV_SHOW_OTP === "1" ? { devOtp: otp } : {};   // never set in production
  return json({
    ok: true, next: "otp",
    sentVia: sent.map((j) => ({ via: j.via, to: j.to })),
    sentTo: sent.map((j) => `${j.via} ${j.to}`).join(" and "),
    ...extra,
  });
}

// POST /api/auth/start  {id}  -> tells the page whether to ask for a password or an OTP
async function authStart(request, env, db) {
  const id = cleanId((await body(request)).id);
  if (!id) return fail("Enter your Enrollment ID.");
  const person = await findPerson(db, id, env);
  if (!person) return fail("No student or centre found with this ID. Check the ID on your admission slip.", 404);
  const acc = await accounts(db).findOne({ _id: id }, { projection: { passwordHash: 1 } });
  if (acc?.passwordHash) return json({ ok: true, next: "password", name: person.name.split(" ")[0] });
  return sendOtp(env, db, person, "setup");
}

// POST /api/auth/forgot  {id}
async function authForgot(request, env, db) {
  const id = cleanId((await body(request)).id);
  const person = id && (await findPerson(db, id, env));
  if (!person) return fail("No student or centre found with this ID.", 404);
  return sendOtp(env, db, person, "reset");
}

// POST /api/auth/verify-otp  {id, otp}  -> short-lived token that allows setting a password
async function authVerifyOtp(request, env, db) {
  const b = await body(request);
  const id = cleanId(b.id), otp = String(b.otp || "").replace(/\D/g, "");
  if (!id || otp.length !== 6) return fail("Enter the 6-digit code from your email.");
  const acc = await accounts(db).findOne({ _id: id });
  const o = acc?.otp;
  if (!o || !o.hash) return fail("Please request a new code.", 400);
  if (o.expiresAt < Date.now()) return fail("This code has expired. Please request a new one.", 400);
  if (o.tries >= OTP_MAX_TRIES) return fail("Too many wrong codes. Please request a new one.", 429);
  if ((await otpHash(env.SESSION_SECRET, id, otp)) !== o.hash) {
    await accounts(db).updateOne({ _id: id }, { $inc: { "otp.tries": 1 } });
    const left = OTP_MAX_TRIES - (o.tries + 1);
    return fail(left > 0 ? `Wrong code. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Please request a new one.", 400);
  }
  const nonce = randomId();
  await accounts(db).updateOne({ _id: id }, { $set: { setupNonce: nonce, updatedAt: new Date() }, $unset: { otp: "" } });
  const setupToken = await signToken(env.SESSION_SECRET, { sub: id, role: acc.role, purpose: "setpw", n: nonce, exp: Date.now() + SETUP_TTL });
  return json({ ok: true, setupToken });
}

// POST /api/auth/set-password  {setupToken, password}
async function authSetPassword(request, env, db) {
  const b = await body(request);
  const t = await readToken(env.SESSION_SECRET, b.setupToken);
  if (!t || t.purpose !== "setpw") return fail("Your verification has expired. Please start again.", 401);
  const problem = passwordProblem(b.password);
  if (problem) return fail(problem);
  const acc = await accounts(db).findOne({ _id: t.sub });
  if (!acc || acc.setupNonce !== t.n) return fail("This link was already used. Please start again.", 401);
  const tokenVersion = (acc.tokenVersion || 0) + 1;   // logs out old sessions after a reset
  await accounts(db).updateOne({ _id: t.sub }, {
    $set: { passwordHash: await hashPassword(b.password), passwordSetAt: new Date(), tokenVersion, failedLogins: 0, updatedAt: new Date() },
    $unset: { setupNonce: "", lockUntil: "" },
  });
  return json({ ok: true, token: await signToken(env.SESSION_SECRET, { sub: t.sub, role: acc.role, tv: tokenVersion, exp: Date.now() + SESSION_TTL }) });
}

// POST /api/auth/login  {id, password}
async function authLogin(request, env, db) {
  const b = await body(request);
  const id = cleanId(b.id);
  if (!id || !b.password) return fail("Enter your Enrollment ID and password.");
  const acc = await accounts(db).findOne({ _id: id });
  if (!acc?.passwordHash) return fail("Incorrect ID or password.", 401);
  if (acc.lockUntil && acc.lockUntil > Date.now()) {
    return fail(`Too many wrong attempts. Try again in ${Math.ceil((acc.lockUntil - Date.now()) / 60000)} minutes, or use "Forgot password".`, 429);
  }
  if (!(await verifyPassword(String(b.password), acc.passwordHash))) {
    const fails = (acc.failedLogins || 0) + 1;
    const set = fails >= LOGIN_MAX_FAILS ? { failedLogins: 0, lockUntil: Date.now() + LOCK_TIME } : { failedLogins: fails };
    await accounts(db).updateOne({ _id: id }, { $set: set });
    return fail(fails >= LOGIN_MAX_FAILS ? "Too many wrong attempts. Try again in 15 minutes, or use \"Forgot password\"." : "Incorrect ID or password.", fails >= LOGIN_MAX_FAILS ? 429 : 401);
  }
  await accounts(db).updateOne({ _id: id }, { $set: { failedLogins: 0, lastLoginAt: new Date() }, $unset: { lockUntil: "" } });
  return json({ ok: true, token: await signToken(env.SESSION_SECRET, { sub: id, role: acc.role, tv: acc.tokenVersion || 0, exp: Date.now() + SESSION_TTL }) });
}


// ---------- GET /api/me : dashboard ----------
async function me(request, env, db) {
  const s = await session(request, env, db);
  if (!s) return fail("Please log in again.", 401);
  if (s.role === "admin") { const a = adminList(env).find((x) => x.id === s.sub); return json({ ok: true, role: "admin", id: s.sub, name: str(a?.name || "Admin") }); }
  return json({ ok: true, ...(s.role === "franchise" ? await franchiseDash(db, s.sub) : await studentDash(db, s.sub)) });
}

async function studentDash(db, id) {
  const st = await db.collection("students").findOne({ _id: id }, {
    projection: { name: 1, fatherName: 1, rollNo: 1, institute: 1, admissionDate: 1, enrolledCourses: 1, certificates: 1, mobileNo: 1, email: 1 },
  });
  if (!st) return { role: "student", id, name: "", courses: [], certificates: [], receipts: [] };
  const feeDoc = await db.collection("fees").findOne({ _id: id }, { projection: { courses: 1 } });
  const receipts = await db.collection("feereceipts").find({ studentId: id }, {
    projection: { courseId: 1, courseName: 1, amount: 1, paymentDate: 1, paymentMode: 1 }, sort: { paymentDate: -1 },
  }).toArray();

  const courses = (st.enrolledCourses || []).map((c) => {
    const cid = String(c._id || "");
    const f = (feeDoc?.courses || []).find((x) => String(x.courseId || x._id) === cid);
    const mine = receipts.filter((r) => String(r.courseId) === cid);
    const total = f ? num(f.totalAmount) : num(c.discountedPrice);
    const paid = mine.length ? mine.reduce((a, r) => a + num(r.amount), 0) : num(f?.amountPaid);
    return {
      name: str(c.name), duration: fmtDuration(c.completionDuration), status: str(c.status || "Enrolled", 40),
      enrolledOn: c.enrollmentDate || null, total, paid, due: Math.max(0, total - paid),
      discount: num(c.discount), discountReason: str(c.discountReason),
    };
  });
  return {
    role: "student", id, name: str(st.name), fatherName: str(st.fatherName), rollNo: str(st.rollNo, 20),
    centre: str(st.institute?.name), admissionDate: st.admissionDate || null,
    email: maskEmail(st.email), courses,
    feeTotal: courses.reduce((a, c) => a + c.total, 0), feePaid: courses.reduce((a, c) => a + c.paid, 0),
    feeDue: courses.reduce((a, c) => a + c.due, 0),
    certificates: (st.certificates || []).map((c) => ({ certificateId: str(c.certificateId, 40), course: str(c.course?.name || c.name), issueDate: c.issueDate || null, pdf: /^https:\/\/res\.cloudinary\.com\//.test(c.url || "") ? c.url : "" })),
    receipts: receipts.map((r) => ({ receiptNo: str(r._id, 40), course: str(r.courseName), amount: num(r.amount), date: r.paymentDate || null, mode: str(r.paymentMode, 30) })),
  };
}

async function franchiseDash(db, id) {
  const f = await db.collection("franchises").findOne({ _id: id }, {
    projection: { name: 1, "director.name": 1, grantDate: 1, district: 1, state: 1, certificates: 1, noOfComputers: 1 },
  });
  const certs = (f?.certificates || []).slice().sort((a, b) => new Date(b.validTill || 0) - new Date(a.validTill || 0));
  const latest = certs[0];
  const students = await db.collection("students").countDocuments({ "institute._id": id });
  return {
    role: "franchise", id, name: str(f?.name), director: str(f?.director?.name), grantDate: f?.grantDate || null,
    district: str(f?.district), computers: num(f?.noOfComputers), students,
    certificateId: str(latest?.certificateId, 40), validTill: latest?.validTill || null,
    valid: !!(latest?.validTill && new Date(latest.validTill) >= new Date()),
  };
}

// ---------- GET /api/verify?id=CERT-XXXXXX ----------
async function verify(request, env, db) {
  const id = cleanId(new URL(request.url).searchParams.get("id"));
  if (!/^[A-Z0-9-]{4,30}$/.test(id)) return fail("Enter a valid certificate number.");
  const st = await db.collection("students").findOne({ "certificates.certificateId": id }, {
    projection: { name: 1, fatherName: 1, institute: 1, certificates: 1 },
  });
  if (st) {
    const c = (st.certificates || []).find((x) => cleanId(x.certificateId) === id);
    return json({ ok: true, found: true, type: "student", certificateId: id, name: str(st.name), fatherName: str(st.fatherName), course: str(c?.course?.name || c?.name), issueDate: c?.issueDate || null, centre: str(st.institute?.name) });
  }
  const fr = await db.collection("franchises").findOne({ "certificates.certificateId": id }, { projection: { name: 1, district: 1, certificates: 1 } });
  if (fr) {
    const c = (fr.certificates || []).find((x) => cleanId(x.certificateId) === id);
    return json({ ok: true, found: true, type: "franchise", certificateId: id, centre: str(fr.name), district: str(fr.district), issueDate: c?.issueDate || null, validTill: c?.validTill || null, valid: !!(c?.validTill && new Date(c.validTill) >= new Date()) });
  }
  return json({ ok: true, found: false });
}

// ---------- GET /api/courses ----------
async function courses(request, env, db) {
  const list = await db.collection("courses").find({ visiblity: "Public" }, {
    projection: { name: 1, slug: 1, price: 1, duration: 1, category: 1, type: 1, level: 1, language: 1, description: 1, syllabus: 1, isTopCourse: 1, isFree: 1 },
  }).toArray();
  list.sort((a, b) => (b.isTopCourse === true) - (a.isTopCourse === true) || String(a.name).localeCompare(String(b.name)));
  return new Response(JSON.stringify({
    ok: true,
    courses: list.map((c) => ({
      id: String(c._id), name: str(c.name), slug: str(c.slug), price: c.isFree ? 0 : num(c.price),
      duration: fmtDuration(c.duration), category: str(c.category, 60), type: str(c.type, 40), level: str(c.level, 40),
      language: str(c.language, 60), description: str(c.description, 400), syllabus: (c.syllabus || []).map((x) => str(x, 160)).slice(0, 40),
      top: c.isTopCourse === true,
    })),
  }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
}

// ---------- POST /api/admission : online admission request ----------
async function admission(request, env, db) {
  const b = await body(request);
  const phone = String(b.phone || "").replace(/\D/g, "").slice(-10);
  const doc = {
    name: str(b.name, 100), fatherName: str(b.fatherName, 100), motherName: str(b.motherName, 100),
    dob: str(b.dob, 10), gender: str(b.gender, 10), mobileNo: phone, email: str(b.email, 150),
    qualification: str(b.qualification, 100), address: str(b.address, 250), course: str(b.course, 150),
    batch: str(b.batch, 40), status: "New", source: "website", createdAt: new Date(),
  };
  if (!doc.name || !doc.fatherName || !/^[6-9]\d{9}$/.test(phone) || !doc.address || !doc.course) {
    return fail("Please fill in name, father's name, a 10-digit mobile number, address and course.");
  }
  await db.collection("admissionrequests").insertOne({ _id: `REQ-${Date.now().toString(36).toUpperCase()}${randomId(3)}`, ...doc });
  return json({ ok: true });
}

// ---------- router ----------
const ROUTES = {
  "POST /api/auth/start": authStart,
  "POST /api/auth/forgot": authForgot,
  "POST /api/auth/verify-otp": authVerifyOtp,
  "POST /api/auth/set-password": authSetPassword,
  "POST /api/auth/login": authLogin,
  "GET /api/me": me,
  "GET /api/verify": verify,
  "GET /api/courses": courses,
  "POST /api/admission": admission,
  "GET /api/certificate": certificatePublic,
  ...ADMIN_ROUTES,
};

export async function handle(request, env, getDb) {
  const url = new URL(request.url);
  const fn = ROUTES[`${request.method} ${url.pathname.replace(/\/+$/, "")}`];
  if (!fn) return fail("Not found.", 404);
  if (request.method === "POST") {
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== url.host) return fail("Requests from other websites are not allowed.", 403);
  }
  try {
    return await fn(request, env, await getDb());
  } catch (e) {
    console.error(e);
    return fail("Something went wrong on our side. Please try again.", 500);
  }
}
