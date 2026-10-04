// Public website APIs and the logged-in student / franchise dashboard.
import { num, str, cleanId, fmtDuration, maskEmail, maskPhone, indianMobile, isName, isEmail, isPincode, slugify, randomId, cloudUrl } from "./lib.js";
import { json, fail, body, session, adminList, rateLimit, tooMany } from "./http.js";

const PUBLIC_CACHE = { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60" };
const newId = (prefix) => `${prefix}-${Date.now().toString(36).toUpperCase()}${randomId(3).replace(/[-_]/g, "X")}`;

// ---------- courses: one source for home, courses page, course pages, forms, sitemap ----------
export async function publicCourses(db) {
  const rows = await db.collection("courses").find({ visiblity: "Public" }, {
    projection: { name: 1, slug: 1, price: 1, duration: 1, category: 1, type: 1, level: 1, language: 1, description: 1, longDescription: 1,
      syllabus: 1, isTopCourse: 1, isFree: 1, thumbnail: 1, eligibility: 1, careerScope: 1, createdAt: 1, updatedAt: 1 },
  }).toArray();
  const used = new Set();
  const list = rows.map((c) => {
    let slug = slugify(c.slug || c.name);
    if (used.has(slug)) slug = `${slug}-${String(c._id).slice(-4)}`;
    used.add(slug);
    return {
      id: String(c._id), name: str(c.name), slug, price: c.isFree ? 0 : num(c.price), free: c.isFree === true,
      duration: fmtDuration(c.duration), category: str(c.category, 60).replace(/-/g, " "), type: str(c.type, 40), level: str(c.level, 40),
      language: str(c.language, 60), description: str(c.description, 400), longDescription: str(c.longDescription, 5000),
      syllabus: (Array.isArray(c.syllabus) ? c.syllabus : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 60),
      eligibility: str(c.eligibility, 300), careerScope: str(c.careerScope, 400), image: cloudUrl(c.thumbnail),
      top: c.isTopCourse === true, createdAt: c.createdAt || null, updatedAt: c.updatedAt || c.createdAt || null,
    };
  });
  list.sort((a, b) => (b.top - a.top) || a.name.localeCompare(b.name));
  // Recommended: courses marked "top"; if none are marked, the newest courses.
  const top = list.filter((c) => c.top);
  const rec = new Set((top.length ? top : list.slice().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 6)).map((c) => c.id));
  list.forEach((c) => { c.recommended = rec.has(c.id); });
  return list;
}

async function courses(request, env, db) {
  return new Response(JSON.stringify({ ok: true, courses: await publicCourses(db) }), { headers: PUBLIC_CACHE });
}

// ---------- GET /api/site: homepage numbers and approved reviews ----------
async function site(request, env, db) {
  const [students, coursesCount, franchises, settings, reviews] = await Promise.all([
    db.collection("students").countDocuments({}),
    db.collection("courses").countDocuments({ visiblity: "Public" }),
    db.collection("franchises").countDocuments({}),
    db.collection("settings").findOne({ _id: "site" }),
    db.collection("feedback").find({ showOnSite: true }, { projection: { name: 1, course: 1, message: 1, rating: 1 }, sort: { createdAt: -1 }, limit: 12 }).toArray(),
  ]);
  const fmt = (n) => Number(n).toLocaleString("en-IN");
  const configured = (settings?.stats || []).filter((s) => s && str(s.value, 20) && str(s.label, 40)).slice(0, 4);
  const stats = configured.length ? configured.map((s) => ({ value: str(s.value, 20), label: str(s.label, 40) })) : [
    students > 0 && { value: fmt(students), label: "Students enrolled" },
    coursesCount > 0 && { value: fmt(coursesCount), label: coursesCount === 1 ? "Course" : "Courses" },
    franchises > 0 && { value: fmt(franchises), label: franchises === 1 ? "Franchise centre" : "Franchise centres" },
  ].filter(Boolean);
  return new Response(JSON.stringify({
    ok: true, stats, configured: configured.length > 0,
    reviews: reviews.map((r) => ({ name: str(r.name, 60), course: str(r.course, 120), text: str(r.message, 600), rating: Math.min(5, Math.max(1, num(r.rating) || 5)) })),
  }), { headers: PUBLIC_CACHE });
}

// ---------- GET /api/me: dashboard data for the logged-in person only ----------
async function me(request, env, db) {
  const s = await session(request, env, db);
  if (!s) return fail("Your session has ended. Please log in again.", 401);
  if (s.role === "admin") { const a = adminList(env).find((x) => x.id === s.sub); return json({ ok: true, role: "admin", id: s.sub, name: str(a?.name || "Admin") }); }
  return json({ ok: true, ...(s.role === "franchise" ? await franchiseDash(db, s.sub) : await studentDash(db, s.sub)) });
}

async function studentDash(db, id) {
  const st = await db.collection("students").findOne({ _id: id }, {
    projection: { name: 1, fatherName: 1, motherName: 1, rollNo: 1, institute: 1, admissionDate: 1, dob: 1, gender: 1, mobileNo: 1, email: 1,
      district: 1, state: 1, qualification: 1, enrolledCourses: 1, certificates: 1, marksheets: 1 },
  });
  if (!st) return { role: "student", id, name: "", courses: [], certificates: [], feeHistory: [], feeTotal: 0, feePaid: 0, feeDue: 0 };
  const feeDoc = await db.collection("fees").findOne({ _id: id }, { projection: { courses: 1 } });
  const receipts = await db.collection("feereceipts").find({ studentId: id }, {
    projection: { courseId: 1, courseName: 1, amount: 1, paymentDate: 1, paymentMode: 1 },
  }).toArray();

  const courses = (st.enrolledCourses || []).map((c) => {
    const cid = String(c._id || "");
    const f = (feeDoc?.courses || []).find((x) => String(x.courseId || x._id) === cid);
    const mine = receipts.filter((r) => String(r.courseId) === cid);
    const total = f ? num(f.totalAmount) : num(c.discountedPrice);
    const paid = mine.length ? mine.reduce((a, r) => a + num(r.amount), 0) : num(f?.amountPaid);
    return { id: cid, name: str(c.name), duration: fmtDuration(c.completionDuration), status: str(c.status || "Enrolled", 40),
      enrolledOn: c.enrollmentDate || null, originalPrice: num(c.originalPrice), discount: num(c.discount), discountReason: str(c.discountReason),
      total, paid, due: Math.max(0, total - paid) };
  });

  // Fee history: each receipt with the course total and the balance left after that payment.
  const totalOf = Object.fromEntries(courses.map((c) => [c.id, c.total]));
  const byDate = receipts.slice().sort((a, b) => new Date(a.paymentDate || 0) - new Date(b.paymentDate || 0) || String(a._id).localeCompare(String(b._id)));
  const paidSoFar = {};
  const feeHistory = byDate.map((r) => {
    const cid = String(r.courseId || "");
    paidSoFar[cid] = (paidSoFar[cid] || 0) + num(r.amount);
    const total = cid in totalOf ? totalOf[cid] : null;
    const balance = total == null ? null : Math.max(0, total - paidSoFar[cid]);
    return { receiptNo: str(r._id, 40), date: r.paymentDate || null, course: str(r.courseName), courseTotal: total, amount: num(r.amount),
      balance, mode: str(r.paymentMode, 30) || "-", status: balance == null ? "Received" : balance === 0 ? "Fully paid" : "Part payment" };
  }).reverse();

  const docs = [
    ...(st.certificates || []).map((c) => ({ kind: "Certificate", certificateId: str(c.certificateId, 40), course: str(c.course?.name || c.name), issueDate: c.issueDate || null, grade: str(c.grade, 10), pdf: cloudUrl(c.url) })),
    ...(st.marksheets || []).map((m) => ({ kind: "Marksheet", certificateId: str(m.certificateId || m.marksheetId, 40), course: str(m.course?.name || m.name), issueDate: m.issueDate || null, grade: str(m.grade || m.result, 20), pdf: cloudUrl(m.url) })),
  ].filter((d) => d.certificateId);

  return {
    role: "student", id, name: str(st.name), fatherName: str(st.fatherName), motherName: str(st.motherName), rollNo: str(st.rollNo, 20),
    centre: str(st.institute?.name).trim() || "Guru Computer Institute", admissionDate: st.admissionDate || null, dob: st.dob || null,
    gender: str(st.gender, 10), qualification: str(st.qualification, 60), district: str(st.district, 60), state: str(st.state, 60),
    email: maskEmail(st.email), mobile: maskPhone(indianMobile(st.mobileNo)),
    courses, certificates: docs, feeHistory,
    feeTotal: courses.reduce((a, c) => a + c.total, 0), feePaid: courses.reduce((a, c) => a + c.paid, 0), feeDue: courses.reduce((a, c) => a + c.due, 0),
  };
}

async function franchiseDash(db, id) {
  const f = await db.collection("franchises").findOne({ _id: id }, { projection: { name: 1, "director.name": 1, grantDate: 1, district: 1, state: 1, certificates: 1, noOfComputers: 1 } });
  const latest = (f?.certificates || []).slice().sort((a, b) => new Date(b.validTill || 0) - new Date(a.validTill || 0))[0];
  const students = await db.collection("students").countDocuments({ "institute._id": id });
  return { role: "franchise", id, name: str(f?.name).trim(), director: str(f?.director?.name), grantDate: f?.grantDate || null,
    district: str(f?.district), state: str(f?.state), computers: num(f?.noOfComputers), students,
    certificateId: str(latest?.certificateId, 40), validTill: latest?.validTill || null, valid: !!(latest?.validTill && new Date(latest.validTill) >= new Date()) };
}

// ---------- GET /api/me/results: only the logged-in student's own exam results ----------
async function myResults(request, env, db) {
  const s = await session(request, env, db);
  if (!s) return fail("Your session has ended. Please log in again.", 401);
  if (s.role !== "student") return json({ ok: true, results: [] });
  const rows = await db.collection("examresults").find({ "results.studentId": s.sub }, {
    projection: { examName: 1, examCode: 1, examDateTime: 1, course: 1, semester: 1, results: 1 }, sort: { examDateTime: -1 },
  }).toArray();
  const results = rows.map((x) => {
    const r = (x.results || []).find((y) => y.studentId === s.sub);
    if (!r) return null;
    const total = num(r.totalMarks), got = num(r.obtainedMarks);
    return { exam: str(x.examName, 120), code: str(x.examCode, 40), date: x.examDateTime || null, course: str(x.course, 120), semester: str(x.semester, 20),
      totalMarks: total, obtainedMarks: got, percent: total ? Math.round((got / total) * 1000) / 10 : null, status: str(r.status, 20) || "-",
      subjects: (r.subjectBreakdown || []).map((b) => ({ name: str(b.subjectName, 120), total: num(b.totalMarks), scored: num(b.scoredMarks) })) };
  }).filter(Boolean);
  return json({ ok: true, results });
}

// ---------- GET /api/verify?id=CERT-XXXXXX (certificates, marksheets and franchise certificates) ----------
async function verify(request, env, db) {
  const wait = await rateLimit(db, env, request, "verify", 60, 600);
  if (wait) return tooMany(wait);
  const id = cleanId(new URL(request.url).searchParams.get("id"));
  if (!/^[A-Z]{2,6}-[A-Z0-9-]{3,24}$/.test(id)) return fail("Enter the certificate number as printed, for example CERT-AB12CD.", 400, { reason: "format" });
  const st = await db.collection("students").findOne({ $or: [{ "certificates.certificateId": id }, { "marksheets.certificateId": id }, { "marksheets.marksheetId": id }] }, {
    projection: { name: 1, fatherName: 1, institute: 1, certificates: 1, marksheets: 1 },
  });
  if (st) {
    const c = (st.certificates || []).find((x) => cleanId(x.certificateId) === id);
    const m = !c && (st.marksheets || []).find((x) => cleanId(x.certificateId || x.marksheetId) === id);
    const d = c || m;
    const revoked = d?.isRevoked === true || /revoked|cancel/i.test(String(d?.status || ""));
    return json({ ok: true, found: true, valid: !revoked, type: c ? "certificate" : "marksheet", certificateId: id, name: str(st.name), fatherName: str(st.fatherName),
      course: str(d?.course?.name || d?.name), issueDate: d?.issueDate || null, grade: str(d?.grade || d?.result, 20), centre: str(st.institute?.name).trim() || "Guru Computer Institute" });
  }
  const fr = await db.collection("franchises").findOne({ "certificates.certificateId": id }, { projection: { name: 1, district: 1, certificates: 1 } });
  if (fr) {
    const c = (fr.certificates || []).find((x) => cleanId(x.certificateId) === id);
    const valid = !!(c?.validTill && new Date(c.validTill) >= new Date());
    return json({ ok: true, found: true, valid, type: "franchise", certificateId: id, centre: str(fr.name).trim(), district: str(fr.district), issueDate: c?.issueDate || null, validTill: c?.validTill || null });
  }
  return json({ ok: true, found: false });
}

// ---------- public forms ----------
async function formGuard(request, env, db, bucket) {
  const wait = await rateLimit(db, env, request, `form-${bucket}`, 6, 600);
  return wait ? tooMany(wait) : null;
}
async function isDuplicate(db, coll, filter, minutes) {
  return !!(await db.collection(coll).findOne({ ...filter, createdAt: { $gt: new Date(Date.now() - minutes * 60000) } }, { projection: { _id: 1 } }));
}
const DONE = "Thank you. Your enquiry has been submitted successfully.";

// POST /api/contact {name, mobile, email, subject, message, course, source}
async function contact(request, env, db) {
  const g = await formGuard(request, env, db, "contact"); if (g) return g;
  const b = await body(request);
  const source = b.source === "callback" ? "callback" : "contact";
  const doc = { name: str(b.name, 100), mobileNo: indianMobile(b.mobile), email: str(b.email, 150), subject: str(b.subject, 120) || (source === "callback" ? "Callback request" : "General enquiry"),
    message: str(b.message, 1000), course: str(b.course, 150), source, status: "New", createdAt: new Date() };
  if (!isName(doc.name)) return fail("Enter your name (letters only).", 400, { field: "name" });
  if (!doc.mobileNo) return fail("Enter a valid 10-digit mobile number.", 400, { field: "mobile" });
  if (doc.email && !isEmail(doc.email)) return fail("Enter a valid email address, or leave it empty.", 400, { field: "email" });
  if (await isDuplicate(db, "contactenquiries", { mobileNo: doc.mobileNo, source }, 10)) return json({ ok: true, duplicate: true, message: DONE });
  await db.collection("contactenquiries").insertOne({ _id: newId("ENQ"), ...doc });
  return json({ ok: true, message: DONE });
}

// POST /api/franchise-enquiry
async function franchiseEnquiry(request, env, db) {
  const g = await formGuard(request, env, db, "franchise"); if (g) return g;
  const b = await body(request);
  const doc = { name: str(b.name, 100), mobileNo: indianMobile(b.mobile), email: str(b.email, 150), city: str(b.city, 80), state: str(b.state, 60),
    pincode: str(b.pincode, 6), profession: str(b.profession, 120), preferredLocation: str(b.preferredLocation, 150), space: str(b.space, 60),
    message: str(b.message, 1000), status: "New", createdAt: new Date() };
  if (!isName(doc.name)) return fail("Enter your name (letters only).", 400, { field: "name" });
  if (!doc.mobileNo) return fail("Enter a valid 10-digit mobile number.", 400, { field: "mobile" });
  if (doc.email && !isEmail(doc.email)) return fail("Enter a valid email address, or leave it empty.", 400, { field: "email" });
  if (!doc.city) return fail("Enter your city or town.", 400, { field: "city" });
  if (!doc.state) return fail("Enter your state.", 400, { field: "state" });
  if (doc.pincode && !isPincode(doc.pincode)) return fail("Pincode must have 6 digits.", 400, { field: "pincode" });
  if (await isDuplicate(db, "franchiseenquiries", { mobileNo: doc.mobileNo }, 24 * 60)) return json({ ok: true, duplicate: true, message: "Thank you. We already have your franchise enquiry and will contact you soon." });
  await db.collection("franchiseenquiries").insertOne({ _id: newId("FRQ"), ...doc });
  return json({ ok: true, message: "Thank you. Your franchise enquiry has been submitted successfully. We will contact you soon." });
}

// POST /api/feedback {name, course, rating, message}
async function feedback(request, env, db) {
  const g = await formGuard(request, env, db, "feedback"); if (g) return g;
  const b = await body(request);
  const doc = { name: str(b.name, 100), course: str(b.course, 150), rating: Math.round(num(b.rating)), message: str(b.message, 1000), status: "New", showOnSite: false, createdAt: new Date() };
  if (!isName(doc.name)) return fail("Enter your name (letters only).", 400, { field: "name" });
  if (!(doc.rating >= 1 && doc.rating <= 5)) return fail("Choose a rating from 1 to 5.", 400, { field: "rating" });
  if (doc.message.length < 5) return fail("Write a few words of feedback.", 400, { field: "message" });
  await db.collection("feedback").insertOne({ _id: newId("FDB"), ...doc });
  return json({ ok: true, message: "Thank you for your feedback." });
}

// POST /api/admission: online admission request (the institute confirms and admits from the admin panel)
async function admission(request, env, db) {
  const g = await formGuard(request, env, db, "admission"); if (g) return g;
  const b = await body(request);
  const doc = { name: str(b.name, 100), fatherName: str(b.fatherName, 100), motherName: str(b.motherName, 100), dob: /^\d{4}-\d{2}-\d{2}$/.test(b.dob || "") ? b.dob : "",
    gender: ["Male", "Female", "Other"].includes(b.gender) ? b.gender : "", mobileNo: indianMobile(b.phone), email: str(b.email, 150),
    qualification: str(b.qualification, 100), address: str(b.address, 250), course: str(b.course, 150), batch: str(b.batch, 40),
    status: "New", source: "website", createdAt: new Date() };
  if (!isName(doc.name)) return fail("Enter the student's name (letters only).", 400, { field: "name" });
  if (!isName(doc.fatherName)) return fail("Enter the father's name (letters only).", 400, { field: "fatherName" });
  if (doc.motherName && !isName(doc.motherName)) return fail("Enter the mother's name using letters only, or leave it empty.", 400, { field: "motherName" });
  if (!doc.mobileNo) return fail("Enter a valid 10-digit mobile number.", 400, { field: "phone" });
  if (doc.email && !isEmail(doc.email)) return fail("Enter a valid email address, or leave it empty.", 400, { field: "email" });
  if (doc.address.length < 3) return fail("Enter the address.", 400, { field: "address" });
  if (!doc.course) return fail("Choose a course.", 400, { field: "course" });
  if (doc.dob && (new Date(doc.dob) > new Date() || new Date(doc.dob) < new Date("1930-01-01"))) return fail("Enter a valid date of birth.", 400, { field: "dob" });
  if (await isDuplicate(db, "admissionrequests", { mobileNo: doc.mobileNo, course: doc.course }, 24 * 60)) return json({ ok: true, duplicate: true });
  await db.collection("admissionrequests").insertOne({ _id: newId("REQ"), ...doc });
  return json({ ok: true });
}

export const PUBLIC_ROUTES = {
  "GET /api/courses": courses,
  "GET /api/site": site,
  "GET /api/me": me,
  "GET /api/me/results": myResults,
  "GET /api/verify": verify,
  "POST /api/contact": contact,
  "POST /api/franchise-enquiry": franchiseEnquiry,
  "POST /api/feedback": feedback,
  "POST /api/admission": admission,
};
