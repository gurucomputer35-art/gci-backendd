// Handles every request that is not a plain file in ./public:
// /api/*, /sitemap.xml, old URLs, and the website pages (/login, /courses/<slug>, ...), each with its own title and meta tags.
import { handle } from "./app.js";
import { SECURITY_HEADERS } from "./http.js";
import { publicCourses } from "./public.js";
import { routeFor, headBlock, injectHead, organizationLd, courseLd, breadcrumbLd, sitemapXml, REDIRECTS, NOT_FOUND } from "./seo.js";

const siteUrl = (env) => String(env.SITE_URL || "https://www.gurucomputerinstitute.com").replace(/\/+$/, "");

function respond(body, status, type, extra = {}) {
  return new Response(body, { status, headers: { "content-type": type, ...SECURITY_HEADERS, ...extra } });
}

async function coursesOrEmpty(getDb) {
  try { return await publicCourses(await getDb()); } catch (e) { console.error("Courses for page failed", e?.message); return null; }
}

export async function handleRequest(request, env, ctx, getDb) {
  const url = new URL(request.url);
  const site = siteUrl(env);

  // One address for the whole site: gurucomputerinstitute.com -> www.gurucomputerinstitute.com
  const main = new URL(site);
  if (url.hostname !== main.hostname && url.hostname === main.hostname.replace(/^www\./, "")) {
    return Response.redirect(`${main.origin}${url.pathname}${url.search}`, 301);
  }

  if (url.pathname.startsWith("/api/")) return handle(request, env, getDb);
  if (!["GET", "HEAD"].includes(request.method)) return respond("Method not allowed", 405, "text/plain; charset=utf-8");

  if (url.pathname === "/sitemap.xml") {
    const list = (await coursesOrEmpty(getDb)) || [];
    return respond(sitemapXml(site, list), 200, "application/xml; charset=utf-8", { "cache-control": "public, max-age=3600" });
  }

  const clean = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "/";
  if (REDIRECTS[clean]) return Response.redirect(`${url.origin}${REDIRECTS[clean]}${url.search}`, 301);
  if (clean !== url.pathname) return Response.redirect(`${url.origin}${clean}${url.search}`, 301);   // no trailing slashes

  const route = routeFor(clean);
  let meta = route, status = route.status || 200;
  const jsonld = [organizationLd(site)];
  if (route.page === "course") {
    const list = await coursesOrEmpty(getDb);
    const c = list && list.find((x) => x.slug === route.course);
    if (c) {
      meta = { title: `${c.name} | Guru Computer Institute`, description: (c.description || `${c.name} at Guru Computer Institute, Raja Ka Tajpur, Bijnor.`) + (c.duration ? ` Duration: ${c.duration}.` : ""), path: clean, image: c.image, ogType: "article" };
      jsonld.push(courseLd(site, c), breadcrumbLd(site, [["Home", "/"], ["Courses", "/courses"], [c.name, clean]]));
    } else if (list) {
      meta = { ...NOT_FOUND, path: clean }; status = 404;
    } else {
      meta = { title: "Course | Guru Computer Institute", description: "Course details at Guru Computer Institute.", path: clean };   // database unreachable: page still loads
    }
  }

  const page = await env.ASSETS.fetch(new Request(new URL("/", url), { headers: { accept: "text/html" } }));
  if (!page.ok) return respond("The website is temporarily unavailable.", 503, "text/plain; charset=utf-8");
  const html = injectHead(await page.text(), headBlock(site, { ...meta, jsonld }));
  return respond(html, status, "text/html; charset=utf-8", { "cache-control": "public, max-age=0, must-revalidate" });
}
