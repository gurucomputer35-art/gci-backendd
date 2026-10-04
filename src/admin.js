// Admin routes. Everything is written in the same shape as the old system's records.
import { json, fail, body, session, adminList } from "./http.js";
import { num, str, cleanId, fmtDuration, maskEmail, indianMobile, cloudinaryReady, uploadPrivate, randomCode, hex24, escapeRegex } from "./lib.js";

const HEAD_OFFICE = { _id: "GCI000", name: "Guru Computer Institute" };
const PAY_MODES = ["Cash", "UPI", "Bank Transfer", "Card", "Cheque"];
const toDate = (v, fallback = null) => {
  if (!v) return fallback;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T09:00:00+05:30`) : new Date(v);
  return isNaN(d) ? fallback : d;
};
const sumDue = (feeCourses) => (feeCourses || []).reduce((a, c) => a + Math.max(0, num(c.dueAmount)), 0);

async function requireAdmin(request, env, db) {
  const s = await session(request, env, db);
  if (!s || s.role !== "admin") return null;
  const a = adminList(env).find((x) => x.id === s.sub);
  return { id: s.sub, name: str(a?.name || "Admin") };
}
const guard = (fn) => async (request, env, db) => {
  const admin = await requireAdmin(request, env, db);
  if (!admin) return fail("Please log in as admin.", 401);
  return fn(request, env, db, admin);
};

async function allCourses(db) {
  return db.collection("courses").find({}, { projection: { name: 1, price: 1, duration: 1, category: 1, visiblity: 1, isFree: 1 } }).toArray();
}
async function findCourse(db, id) {
  return (await allCourses(db)).find((c) => String(c._id) === String(id)) || null;
}

// Highest number after a prefix, e.g. GCI2022340 -> 340 (works for any count of digits)
async function nextNumber(db, coll, field, prefix, pad) {
  const rows = await db.collection(coll).find({ [field]: { $regex: `^${escapeRegex(prefix)}\\d+$` } }, { projection: { [field]: 1 } }).toArray();
  const max = rows.reduce((m, r) => Math.max(m, Number(String(r[field]).slice(prefix.length)) || 0), 0);
  return prefix + String(max + 1).padStart(pad, "0");
}
async function nextRollNo(db) {
  const rows = await db.collection("students").find({}, { projection: { rollNo: 1 } }).toArray();
  return String(rows.reduce((m, r) => Math.max(m, num(r.rollNo)), 0) + 1).padStart(4, "0");
}
async function insertWithNextId(db, coll, makeId, makeDoc) {
  for (let i = 0; i < 5; i++) {
    const id = await makeId(i);
    try { await db.collection(coll).insertOne(makeDoc(id)); return id; }
    catch (e) { if (e?.code !== 11000) throw e; }   // someone else took this number: try the next one
  }
  throw new Error("Could not create a new number. Please try again.");
}

function courseSnapshot(course, discount, reason, date, status = "Enrolled") {
  const price = course.isFree ? 0 : num(course.price);
  const d = Math.max(0, Math.min(price, num(discount)));
  return {
    _id: String(course._id), name: str(course.name), category: str(course.category, 60),
    completionDuration: { type: str(course.duration?.type || "Month", 20), value: String(course.duration?.value || "") },
    discount: String(d), discountReason: str(reason), enrollmentDate: date, status,
    originalPrice: String(price), discountedPrice: String(price - d),
  };
}
function feeEntry(snap, date) {
  const total = num(snap.discountedPrice);
  return {
    _id: snap._id, courseId: snap._id, courseName: snap.name, category: snap.category,
    feeStructure: { CourseFee: String(total) }, totalAmount: String(total), amountPaid: "0", dueAmount: String(total),
    discount: { reason: snap.discountReason, amount: snap.discount },
    dueDate: new Date(date.getTime() + 30 * 864e5), status: total > 0 ? "Pending" : "Paid", paymentHistory: [],
  };
}

// Fee entries for ALL of a student's courses. Older records sometimes have a course with no fee
// entry; those are rebuilt from the course price and the receipts already saved for it.
async function fullFeeCourses(db, student, fee) {
  const list = fee?.courses ? structuredClone(fee.courses) : [];
  const missing = (student.enrolledCourses || []).filter((c) => !list.some((f) => String(f.courseId || f._id) === String(c._id)));
  if (missing.length) {
    const receipts = await db.collection("feereceipts").find({ studentId: student._id }, { projection: { courseId: 1, amount: 1 } }).toArray();
    for (const c of missing) {
      const e = feeEntry(c, new Date(c.enrollmentDate || Date.now()));
      const paid = receipts.filter((r) => String(r.courseId) === String(c._id)).reduce((a, r) => a + num(r.amount), 0);
      Object.assign(e, { amountPaid: String(paid), dueAmount: String(Math.max(0, num(e.totalAmount) - paid)), status: paid >= num(e.totalAmount) ? "Paid" : "Pending" });
      list.push(e);
    }
  }
  return list;
}

// Same rule as fullFeeCourses, but from data already loaded (for lists and totals).
function dueFor(student, fee, receipts) {
  let due = sumDue(fee?.courses);
  for (const c of student.enrolledCourses || []) {
    if ((fee?.courses || []).some((f) => String(f.courseId || f._id) === String(c._id))) continue;
    const paid = receipts.filter((r) => r.studentId === student._id && String(r.courseId) === String(c._id)).reduce((a, r) => a + num(r.amount), 0);
    due += Math.max(0, num(c.discountedPrice) - paid);
  }
  return due;
}

const PERSON_FIELDS = {
  name: 100, fatherName: 100, motherName: 100, email: 150, gender: 10, category: 20, religion: 40, maritalStatus: 20,
  qualification: 60, educationBoard: 60, yearOfPassing: 4, address: 250, district: 60, state: 60, pincode: 6,
};
function personFromBody(b) {
  const p = {};
  for (const [k, max] of Object.entries(PERSON_FIELDS)) p[k] = str(b[k], max);
  p.gender = p.gender.toLowerCase();
  p.mobileNo = indianMobile(b.mobileNo);
  p.aadharNo = String(b.aadharNo || "").replace(/\D/g, "");
  if (b.dob) p.dob = toDate(b.dob);
  return p;
}
function personProblem(p, needAll) {
  if (needAll && (!p.name || !p.fatherName)) return "Student's name and father's name are required.";
  if (needAll && !p.mobileNo) return "Enter a valid 10-digit mobile number.";
  if (p.aadharNo && p.aadharNo.length !== 12) return "Aadhaar number must have 12 digits.";
  if (p.pincode && !/^\d{6}$/.test(p.pincode)) return "Pincode must have 6 digits.";
  if (p.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email)) return "Enter a valid email address, or leave it empty.";
  return null;
}

// ---------- GET /api/admin/stats ----------
async function stats(request, env, db) {
  const now = new Date(), monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const students = await db.collection("students").find({}, { projection: { admissionDate: 1, institute: 1, enrolledCourses: 1 } }).toArray();
  const receipts = await db.collection("feereceipts").find({}, { projection: { amount: 1, paymentDate: 1, studentId: 1, courseId: 1 } }).toArray();
  const fees = await db.collection("fees").find({}, { projection: { courses: 1 } }).toArray();
  const requests = await db.collection("admissionrequests").countDocuments({ status: "New" });
  return json({
    ok: true,
    students: students.length,
    franchiseStudents: students.filter((s) => s.institute?._id && s.institute._id !== "GCI000").length,
    admissionsThisMonth: students.filter((s) => s.admissionDate && new Date(s.admissionDate) >= monthStart).length,
    collectedThisMonth: receipts.filter((r) => r.paymentDate && new Date(r.paymentDate) >= monthStart).reduce((a, r) => a + num(r.amount), 0),
    totalPending: (() => { const byId = Object.fromEntries(fees.map((f) => [f._id, f])); return students.reduce((a, st) => a + dueFor(st, byId[st._id], receipts), 0); })(),
    newRequests: requests,
    uploads: cloudinaryReady(env),
  });
}

// ---------- GET /api/admin/courses ----------
async function courses(request, env, db) {
  const list = await allCourses(db);
  list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return json({ ok: true, courses: list.map((c) => ({ id: String(c._id), name: str(c.name), price: c.isFree ? 0 : num(c.price), duration: fmtDuration(c.duration), public: c.visiblity === "Public" })) });
}

// ---------- GET /api/admin/students?q=&centre=&page= ----------
async function students(request, env, db) {
  const u = new URL(request.url);
  const q = str(u.searchParams.get("q"), 60), centre = cleanId(u.searchParams.get("centre"));
  const page = Math.max(1, Math.min(500, Number(u.searchParams.get("page")) || 1)), per = 25;
  const filter = {};
  if (q) {
    const rx = escapeRegex(q);
    filter.$or = [{ _id: { $regex: rx, $options: "i" } }, { name: { $regex: rx, $options: "i" } }, { mobileNo: { $regex: rx } }, { fatherName: { $regex: rx, $options: "i" } }];
  }
  if (centre) filter["institute._id"] = centre;
  const total = await db.collection("students").countDocuments(filter);
  const rows = await db.collection("students").find(filter, {
    projection: { name: 1, fatherName: 1, mobileNo: 1, institute: 1, enrolledCourses: 1, admissionDate: 1, rollNo: 1 },
    sort: { _id: -1 }, skip: (page - 1) * per, limit: per,
  }).toArray();
  const ids = rows.map((r) => r._id);
  const fees = ids.length ? await db.collection("fees").find({ _id: { $in: ids } }, { projection: { courses: 1 } }).toArray() : [];
  const receipts = ids.length ? await db.collection("feereceipts").find({ studentId: { $in: ids } }, { projection: { studentId: 1, courseId: 1, amount: 1 } }).toArray() : [];
  const feeOf = Object.fromEntries(fees.map((f) => [f._id, f]));
  return json({
    ok: true, total, page, pages: Math.max(1, Math.ceil(total / per)),
    students: rows.map((r) => ({
      id: r._id, name: str(r.name), fatherName: str(r.fatherName), mobileNo: str(r.mobileNo, 15), rollNo: str(r.rollNo, 10),
      centre: str(r.institute?.name).trim(), courses: (r.enrolledCourses || []).map((c) => str(c.name)),
      admissionDate: r.admissionDate || null, due: dueFor(r, feeOf[r._id], receipts),
    })),
  });
}

// ---------- GET /api/admin/student?id= ----------
async function student(request, env, db) {
  const id = cleanId(new URL(request.url).searchParams.get("id"));
  const s = await db.collection("students").findOne({ _id: id });
  if (!s) return fail("Student not found.", 404);
  const fee = await db.collection("fees").findOne({ _id: id });
  const feeCourses = await fullFeeCourses(db, s, fee);
  const receipts = await db.collection("feereceipts").find({ studentId: id }, { sort: { paymentDate: -1 } }).toArray();
  const fc = (cid) => feeCourses.find((c) => String(c.courseId || c._id) === String(cid));
  const out = {};
  for (const k of Object.keys(PERSON_FIELDS)) out[k] = s[k] ?? "";
  return json({
    ok: true,
    student: {
      id: s._id, rollNo: s.rollNo || "", ...out, mobileNo: s.mobileNo || "", dob: s.dob || null, admissionDate: s.admissionDate || null,
      aadharMasked: s.aadharNo ? "XXXX XXXX " + String(s.aadharNo).slice(-4) : "", centre: str(s.institute?.name).trim(), centreId: s.institute?._id || "",
      documents: { photo: s.photo || "", qualification: s.qualificationProofImage || "", identification: s.identificationProofImage || "" },
      courses: (s.enrolledCourses || []).map((c) => {
        const f = fc(c._id);
        const total = f ? num(f.totalAmount) : num(c.discountedPrice), paid = f ? num(f.amountPaid) : 0;
        return { id: String(c._id), name: str(c.name), duration: fmtDuration(c.completionDuration), status: str(c.status), enrolledOn: c.enrollmentDate || null,
          originalPrice: num(c.originalPrice), discount: num(c.discount), discountReason: str(c.discountReason), total, paid, due: Math.max(0, total - paid),
          certificate: (s.certificates || []).find((x) => String(x.course?._id) === String(c._id))?.certificateId || "" };
      }),
      certificates: (s.certificates || []).map((c) => ({ certificateId: c.certificateId, course: str(c.course?.name || c.name), issueDate: c.issueDate || null, grade: c.grade || "", pdf: c.url || "" })),
      receipts: receipts.map((r) => ({ receiptNo: r._id, course: str(r.courseName), amount: num(r.amount), date: r.paymentDate || null, mode: str(r.paymentMode, 30), payerName: str(r.payerName), notes: str(r.notes) })),
    },
  });
}

// ---------- POST /api/admin/student/update ----------
async function updateStudent(request, env, db, admin) {
  const b = await body(request);
  const id = cleanId(b.id);
  const s = await db.collection("students").findOne({ _id: id }, { projection: { name: 1 } });
  if (!s) return fail("Student not found.", 404);
  const p = personFromBody(b);
  const problem = personProblem(p, true);
  if (problem) return fail(problem);
  if (!b.aadharNo) delete p.aadharNo;     // leaving Aadhaar empty keeps the saved number
  const set = { ...p, updatedAt: new Date() };
  await db.collection("students").updateOne({ _id: id }, { $set: set });
  await db.collection("admissions").updateOne({ _id: id }, { $set: set });
  if (p.name !== s.name) await db.collection("fees").updateOne({ _id: id }, { $set: { studentName: p.name } });
  return json({ ok: true });
}

// ---------- POST /api/admin/admission ----------
async function newAdmission(request, env, db, admin) {
  const b = await body(request, 8_000_000);
  const p = personFromBody(b);
  const problem = personProblem(p, true);
  if (problem) return fail(problem);
  const course = await findCourse(db, b.courseId);
  if (!course) return fail("Choose a course.");
  if (!b.force) {
    const dupe = await db.collection("students").findOne({ mobileNo: p.mobileNo, name: { $regex: `^${escapeRegex(p.name)}$`, $options: "i" } }, { projection: { _id: 1 } });
    if (dupe) return fail(`A student with this name and mobile number already exists (${dupe._id}). Open that student to add a new course, or save again to create a separate admission.`, 409, { existingId: dupe._id });
  }
  const date = toDate(b.admissionDate, new Date());
  const snap = courseSnapshot(course, b.discount, b.discountReason, date);
  const prefix = env.STUDENT_ID_PREFIX || "GCI2022";
  const rollNo = await nextRollNo(db);
  const now = new Date();
  const base = { ...p, admissionDate: date, institute: HEAD_OFFICE, admissionBy: "GCI", rollNo, photo: "", qualificationProofImage: "", identificationProofImage: "" };
  if (!base.state) base.state = "Uttar Pradesh";

  const id = await insertWithNextId(db, "students", () => nextNumber(db, "students", "_id", prefix, 3), (newId) => ({
    _id: newId, ...base, IdCard: null, pendingFee: snap.discountedPrice, enrolledCourses: [snap], marksheets: [], certificates: [],
    createdAt: now, updatedAt: now, __v: 0,
  }));

  // documents: uploaded after the ID exists, into the same Cloudinary folders as before (now private)
  const warnings = [];
  const docs = b.documents || {};
  if (Object.values(docs).some((d) => d && d.data)) {
    if (!cloudinaryReady(env)) warnings.push("Documents were not saved because Cloudinary is not set up yet.");
    else {
      const map = { photo: "photo", qualification: "qualificationProofImage", identification: "identificationProofImage" };
      const urls = {};
      for (const [key, field] of Object.entries(map)) {
        if (!docs[key]?.data) continue;
        try { urls[field] = await uploadPrivate(env, docs[key], `users/documents/${id}`, `${id}-${key}`); }
        catch (e) { warnings.push(`${key}: ${e.message}`); }
      }
      if (Object.keys(urls).length) { Object.assign(base, urls); await db.collection("students").updateOne({ _id: id }, { $set: urls }); }
    }
  }
  await db.collection("admissions").insertOne({ _id: id, ...base, course: snap, createdAt: now, updatedAt: now, __v: 0 });
  await db.collection("fees").insertOne({ _id: id, studentId: id, studentName: p.name, institute: HEAD_OFFICE, courses: [feeEntry(snap, date)], createdAt: now, updatedAt: now, __v: 0 });
  if (b.requestId) await db.collection("admissionrequests").updateOne({ _id: str(b.requestId, 40) }, { $set: { status: "Admitted", studentId: id, updatedAt: now } });
  return json({ ok: true, id, rollNo, fee: num(snap.discountedPrice), warnings });
}

// ---------- POST /api/admin/enroll  {id, courseId, discount, discountReason, date} ----------
async function enroll(request, env, db) {
  const b = await body(request);
  const id = cleanId(b.id);
  const s = await db.collection("students").findOne({ _id: id }, { projection: { name: 1, enrolledCourses: 1, institute: 1 } });
  if (!s) return fail("Student not found.", 404);
  const course = await findCourse(db, b.courseId);
  if (!course) return fail("Choose a course.");
  if ((s.enrolledCourses || []).some((c) => String(c._id) === String(course._id) && c.status !== "Completed")) return fail("This student is already enrolled in this course.");
  const date = toDate(b.date, new Date());
  const snap = courseSnapshot(course, b.discount, b.discountReason, date);
  const fee = await db.collection("fees").findOne({ _id: id });
  const feeCourses = [...(await fullFeeCourses(db, s, fee)), feeEntry(snap, date)];
  if (fee) await db.collection("fees").updateOne({ _id: id }, { $set: { courses: feeCourses, updatedAt: new Date() } });
  else await db.collection("fees").insertOne({ _id: id, studentId: id, studentName: s.name, institute: s.institute || HEAD_OFFICE, courses: feeCourses, createdAt: new Date(), updatedAt: new Date(), __v: 0 });
  await db.collection("students").updateOne({ _id: id }, { $set: { enrolledCourses: [...(s.enrolledCourses || []), snap], pendingFee: String(sumDue(feeCourses)), updatedAt: new Date() } });
  return json({ ok: true, fee: num(snap.discountedPrice) });
}

// ---------- POST /api/admin/payment ----------
async function payment(request, env, db, admin) {
  const b = await body(request);
  const id = cleanId(b.studentId), amount = Math.round(num(b.amount));
  const mode = PAY_MODES.includes(b.mode) ? b.mode : "";
  if (!mode) return fail("Choose how the fee was paid.");
  if (!(amount > 0)) return fail("Enter the amount received.");
  const s = await db.collection("students").findOne({ _id: id }, { projection: { name: 1, institute: 1, enrolledCourses: 1 } });
  if (!s) return fail("Student not found.", 404);
  const fee = await db.collection("fees").findOne({ _id: id });
  const feeCourses = await fullFeeCourses(db, { ...s, _id: id }, fee);
  const fc = feeCourses.find((c) => String(c.courseId || c._id) === String(b.courseId));
  if (!fc) return fail("Choose one of the student's courses.");
  const due = Math.max(0, num(fc.totalAmount) - num(fc.amountPaid));
  if (amount > due) return fail(due ? `Amount is more than the pending fee (₹${due.toLocaleString("en-IN")}).` : "This course is already fully paid.");
  const inst = s.institute?._id ? { _id: s.institute._id, name: str(s.institute.name).trim() } : HEAD_OFFICE;
  const date = toDate(b.paymentDate, new Date()), now = new Date();
  const entry = { payerName: str(b.payerName || s.name, 100), paymentDate: date, amount: String(amount), paymentMode: mode,
    transactionId: str(b.transactionId, 60) || null, paidTo: admin.name, notes: str(b.notes, 200) };
  const receiptNo = await insertWithNextId(db, "feereceipts", () => nextNumber(db, "feereceipts", "_id", `${inst._id}-`, 3), (rid) => ({
    _id: rid, courseId: String(fc.courseId || fc._id), courseName: str(fc.courseName), studentId: id, studentName: str(s.name),
    ...entry, institute: inst, createdAt: now, updatedAt: now, __v: 0,
  }));
  const paid = num(fc.amountPaid) + amount;
  Object.assign(fc, { amountPaid: String(paid), dueAmount: String(Math.max(0, num(fc.totalAmount) - paid)), status: paid >= num(fc.totalAmount) ? "Paid" : "Pending" });
  fc.paymentHistory = [...(fc.paymentHistory || []), { _id: receiptNo, ...entry }];
  if (fee) await db.collection("fees").updateOne({ _id: id }, { $set: { courses: feeCourses, updatedAt: now } });
  else await db.collection("fees").insertOne({ _id: id, studentId: id, studentName: s.name, institute: inst, courses: feeCourses, createdAt: now, updatedAt: now, __v: 0 });
  await db.collection("students").updateOne({ _id: id }, { $set: { pendingFee: String(sumDue(feeCourses)), updatedAt: now } });
  return json({ ok: true, receiptNo, due: num(fc.dueAmount) });
}

// ---------- GET /api/admin/receipt?id= ----------
async function receipt(request, env, db) {
  const id = str(new URL(request.url).searchParams.get("id"), 40);
  const r = await db.collection("feereceipts").findOne({ _id: id });
  if (!r) return fail("Receipt not found.", 404);
  const fee = await db.collection("fees").findOne({ _id: r.studentId }, { projection: { courses: 1 } });
  const fc = (fee?.courses || []).find((c) => String(c.courseId || c._id) === String(r.courseId));
  return json({ ok: true, receipt: { receiptNo: r._id, studentId: r.studentId, studentName: str(r.studentName), course: str(r.courseName), amount: num(r.amount),
    date: r.paymentDate, mode: str(r.paymentMode), transactionId: str(r.transactionId || ""), payerName: str(r.payerName), receivedBy: str(r.paidTo), notes: str(r.notes),
    centre: str(r.institute?.name).trim(), courseTotal: fc ? num(fc.totalAmount) : null, courseDue: fc ? num(fc.dueAmount) : null } });
}

// ---------- POST /api/admin/certificate ----------
async function issueCertificate(request, env, db) {
  const b = await body(request);
  const id = cleanId(b.studentId);
  const s = await db.collection("students").findOne({ _id: id }, { projection: { name: 1, enrolledCourses: 1, certificates: 1 } });
  if (!s) return fail("Student not found.", 404);
  const courses = structuredClone(s.enrolledCourses || []);
  const c = courses.find((x) => String(x._id) === String(b.courseId));
  if (!c) return fail("Choose one of the student's courses.");
  if ((s.certificates || []).some((x) => String(x.course?._id) === String(c._id))) return fail("A certificate for this course was already issued.");
  if (!b.force) {
    const fee = await db.collection("fees").findOne({ _id: id }, { projection: { courses: 1 } });
    const fc = (await fullFeeCourses(db, { ...s, _id: id }, fee)).find((x) => String(x.courseId || x._id) === String(c._id));
    const due = fc ? Math.max(0, num(fc.totalAmount) - num(fc.amountPaid)) : 0;
    if (due > 0) return fail(`₹${due.toLocaleString("en-IN")} fee is still pending for this course. Issue the certificate anyway?`, 409, { due });
  }
  let certificateId;
  for (let i = 0; i < 10 && !certificateId; i++) {
    const tryId = `CERT-${randomCode(6)}`;
    const used = (await db.collection("students").findOne({ "certificates.certificateId": tryId }, { projection: { _id: 1 } }))
      || (await db.collection("franchises").findOne({ "certificates.certificateId": tryId }, { projection: { _id: 1 } }));
    if (!used) certificateId = tryId;
  }
  const cert = { url: "", previewUrl: "", name: `${c.name}-certificate`, issueDate: toDate(b.issueDate, new Date()), certificateId,
    course: { _id: String(c._id), name: c.name }, grade: str(b.grade, 10), _id: hex24() };
  c.status = "Completed";
  await db.collection("students").updateOne({ _id: id }, { $set: { certificates: [...(s.certificates || []), cert], enrolledCourses: courses, updatedAt: new Date() } });
  return json({ ok: true, certificateId });
}

// ---------- admission requests from the website ----------
async function requests(request, env, db) {
  const rows = await db.collection("admissionrequests").find({ status: "New" }, { sort: { createdAt: -1 }, limit: 100 }).toArray();
  return json({ ok: true, requests: rows.map((r) => ({ id: String(r._id), name: str(r.name), fatherName: str(r.fatherName), motherName: str(r.motherName), mobileNo: str(r.mobileNo, 15),
    email: str(r.email), dob: str(r.dob, 10), gender: str(r.gender, 10), qualification: str(r.qualification), address: str(r.address), course: str(r.course), batch: str(r.batch), createdAt: r.createdAt || null })) });
}
async function requestStatus(request, env, db) {
  const b = await body(request);
  if (!["Contacted", "Not interested", "New"].includes(b.status)) return fail("Unknown status.");
  await db.collection("admissionrequests").updateOne({ _id: str(b.id, 40) }, { $set: { status: b.status, updatedAt: new Date() } });
  return json({ ok: true });
}

// ---------- GET /api/certificate?id= (public, for the printable certificate page) ----------
export async function certificatePublic(request, env, db) {
  const id = cleanId(new URL(request.url).searchParams.get("id"));
  if (!/^[A-Z0-9-]{4,30}$/.test(id)) return fail("Enter a valid certificate number.");
  const s = await db.collection("students").findOne({ "certificates.certificateId": id }, { projection: { name: 1, fatherName: 1, motherName: 1, rollNo: 1, institute: 1, certificates: 1, enrolledCourses: 1 } });
  if (!s) return json({ ok: true, found: false });
  const c = (s.certificates || []).find((x) => cleanId(x.certificateId) === id);
  const ec = (s.enrolledCourses || []).find((x) => String(x._id) === String(c?.course?._id));
  return json({ ok: true, found: true, certificate: { certificateId: id, studentId: s._id, rollNo: str(s.rollNo, 10), name: str(s.name), fatherName: str(s.fatherName),
    motherName: str(s.motherName), course: str(c?.course?.name || c?.name), duration: fmtDuration(ec?.completionDuration), issueDate: c?.issueDate || null,
    grade: str(c?.grade || "", 10), centre: str(s.institute?.name).trim() || "Guru Computer Institute", pdf: /^https:\/\/res\.cloudinary\.com\//.test(c?.url || "") ? c.url : "" } });
}

export const ADMIN_ROUTES = {
  "GET /api/admin/stats": guard(stats),
  "GET /api/admin/courses": guard(courses),
  "GET /api/admin/students": guard(students),
  "GET /api/admin/student": guard(student),
  "POST /api/admin/student/update": guard(updateStudent),
  "POST /api/admin/admission": guard(newAdmission),
  "POST /api/admin/enroll": guard(enroll),
  "POST /api/admin/payment": guard(payment),
  "GET /api/admin/receipt": guard(receipt),
  "POST /api/admin/certificate": guard(issueCertificate),
  "GET /api/admin/requests": guard(requests),
  "POST /api/admin/request/status": guard(requestStatus),
};
