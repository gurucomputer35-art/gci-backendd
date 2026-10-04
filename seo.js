// Page titles, descriptions, canonical links, social tags, structured data and the sitemap.
// The server puts these into the page before sending it, so search engines see the right details for every URL.
import { escapeHtml as esc } from "./lib.js";

export const NAP = {
  name: "Guru Computer Institute",
  street: "Gurudwara Road, Opposite Diwakar Hospital",
  locality: "Raja Ka Tajpur",
  district: "Bijnor",
  region: "Uttar Pradesh",
  postalCode: "246735",
  phone: "+91-93898-24310",
  email: "info@gurucomputerinstitute.com",
};

const T = (s) => `${s} | Guru Computer Institute`;
export const PAGES = {
  "/": { page: "home", title: "Guru Computer Institute | Computer Courses in Raja Ka Tajpur, Bijnor",
    description: "Practical computer courses in Raja Ka Tajpur, Bijnor: Basic Computer, MS Office, Tally with GST, Advanced Excel, DCA and ADCA, with verified certificates." },
  "/about": { page: "about", title: T("About Us"), description: "Guru Computer Institute on Gurudwara Road, Raja Ka Tajpur, Bijnor teaches practical computer skills with hands-on lab classes." },
  "/courses": { page: "courses", title: T("Computer Courses"), description: "Computer courses at Guru Computer Institute, Bijnor: fees, duration and syllabus for every course." },
  "/gallery": { page: "gallery", title: T("Gallery"), description: "Photos of the computer lab, classes and students at Guru Computer Institute, Raja Ka Tajpur." },
  "/placements": { page: "placements", title: T("Placement & Career Support"), description: "Resume help, interview practice and job guidance for students of Guru Computer Institute." },
  "/student-zone": { page: "student", title: T("Student Zone"), description: "Student facilities, login, certificate verification, admission form and feedback." },
  "/login": { page: "login", title: T("Student Login"), description: "Log in with your Enrollment ID to see your courses, fees, results and certificates.", noindex: true },
  "/dashboard": { page: "dashboard", title: T("My Dashboard"), description: "Your courses, fees, results and certificates.", noindex: true },
  "/verify-certificate": { page: "verify", title: T("Certificate Verification"), description: "Check whether a Guru Computer Institute certificate is genuine using its certificate number." },
  "/admission": { page: "admission", title: T("Admission Form"), description: "Apply for admission to a computer course at Guru Computer Institute, Raja Ka Tajpur, Bijnor." },
  "/feedback": { page: "feedback", title: T("Feedback"), description: "Share your feedback about your course at Guru Computer Institute." },
  "/franchise": { page: "franchise", title: T("Franchise Opportunity"), description: "Open a Guru Computer Institute centre in your town. Apply for a franchise and we will contact you." },
  "/contact": { page: "contact", title: "Contact Guru Computer Institute | Raja Ka Tajpur, Bijnor",
    description: "Address, phone, email and timings of Guru Computer Institute, Gurudwara Road, Raja Ka Tajpur, Bijnor. Send us an enquiry." },
};
export const NOT_FOUND = { page: "notfound", title: T("Page Not Found"), description: "This page could not be found.", noindex: true };
export const REDIRECTS = { "/verify": "/verify-certificate", "/student": "/student-zone", "/staff": "/admin", "/home": "/", "/index": "/" };

// Which page a URL shows. course: "<slug>" for course pages.
export function routeFor(pathname) {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (PAGES[p]) return { ...PAGES[p], path: p };
  if (/^\/dashboard\/(profile|courses|fees|results|certificates)$/.test(p)) return { ...PAGES["/dashboard"], path: p };
  const m = p.match(/^\/courses\/([a-z0-9-]{1,90})$/);
  if (m) return { page: "course", course: m[1], path: p };
  return { ...NOT_FOUND, path: p, status: 404 };
}

export function organizationLd(site) {
  return {
    "@context": "https://schema.org", "@type": ["EducationalOrganization", "LocalBusiness"], "@id": `${site}/#organization`,
    name: NAP.name, url: `${site}/`, logo: `${site}/logo.png`, image: `${site}/logo.png`, telephone: NAP.phone, email: NAP.email,
    address: { "@type": "PostalAddress", streetAddress: NAP.street, addressLocality: NAP.locality, addressRegion: NAP.region, postalCode: NAP.postalCode, addressCountry: "IN" },
    openingHoursSpecification: [{ "@type": "OpeningHoursSpecification", dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], opens: "08:00", closes: "20:00" }],
  };
}
export function courseLd(site, c) {
  const ld = { "@context": "https://schema.org", "@type": "Course", name: c.name, description: c.description || c.longDescription.slice(0, 300) || `${c.name} at ${NAP.name}.`,
    url: `${site}/courses/${c.slug}`, provider: { "@type": "EducationalOrganization", name: NAP.name, sameAs: `${site}/` },
    inLanguage: c.language || undefined, educationalLevel: c.level || undefined,
    hasCourseInstance: { "@type": "CourseInstance", courseMode: "Onsite", location: { "@type": "Place", name: NAP.name, address: `${NAP.street}, ${NAP.locality}, ${NAP.district}` } } };
  if (c.image) ld.image = c.image;
  if (c.price > 0 || c.free) ld.offers = { "@type": "Offer", price: String(c.price), priceCurrency: "INR", category: c.free ? "Free" : "Paid", url: `${site}/courses/${c.slug}` };
  return ld;
}
export function breadcrumbLd(site, items) {
  return { "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: items.map(([name, path], i) => ({ "@type": "ListItem", position: i + 1, name, item: `${site}${path}` })) };
}

// The block between <!--seo--> and <!--/seo--> in index.html
export function headBlock(site, { title, description, path, noindex, image, jsonld = [], ogType = "website" }) {
  const url = `${site}${path === "/" ? "/" : path}`;
  const img = image || `${site}/logo.png`;
  const ld = jsonld.map((x) => `<script type="application/ld+json">${JSON.stringify(x).replace(/</g, "\\u003c")}</script>`).join("\n");
  return `<!--seo-->
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta name="robots" content="${noindex ? "noindex, nofollow" : "index, follow"}">
<meta property="og:site_name" content="Guru Computer Institute">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:locale" content="en_IN">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(img)}">
${ld}
<!--/seo-->`;
}
export function injectHead(html, block) {
  const a = html.indexOf("<!--seo-->"), b = html.indexOf("<!--/seo-->");
  if (a < 0 || b < a) return html;
  return html.slice(0, a) + block + html.slice(b + "<!--/seo-->".length);
}

export function sitemapXml(site, courses) {
  const pages = Object.entries(PAGES).filter(([, v]) => !v.noindex).map(([p]) => ({ loc: `${site}${p === "/" ? "/" : p}`, pr: p === "/" ? "1.0" : "0.7" }));
  const cs = courses.map((c) => ({ loc: `${site}/courses/${c.slug}`, pr: "0.8", mod: c.updatedAt }));
  const iso = (d) => { const x = new Date(d); return isNaN(x) ? "" : `<lastmod>${x.toISOString().slice(0, 10)}</lastmod>`; };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...pages, ...cs]
    .map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.mod ? iso(u.mod) : ""}<priority>${u.pr}</priority></url>`).join("\n")}\n</urlset>\n`;
}
