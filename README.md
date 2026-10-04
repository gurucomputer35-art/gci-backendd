# Guru Computer Institute: website, student portal and admin panel

One Cloudflare Worker serves everything:
- **Website** (`public/index.html`): real URLs such as `/courses`, `/courses/<course>`, `/login`, `/dashboard/fees`, `/contact`
- **Admin panel** (`/admin`)
- **Printable certificates** (`/certificate.html?id=CERT-XXXXXX`)
- **API** (`/api/*`) connected to your MongoDB Atlas database `GuruComputerWebsite`

## Folder layout
```
src/index.js     Worker entry: opens the MongoDB connection
src/worker.js    Routing: API, sitemap, redirects, pages with their own title/meta tags, 404
src/app.js       API router, allowed origins (CORS), error handling
src/auth.js      Login: Enrollment ID -> code on WhatsApp/email -> password; logout
src/public.js    Courses, homepage numbers, dashboard, results, certificate check, public forms
src/admin.js     Admin: students, admissions, fees, certificates, courses, enquiries, franchises, settings
src/seo.js       Page titles, descriptions, structured data, sitemap
src/http.js      Session cookie, rate limits, security headers
src/lib.js       Passwords, tokens, email, WhatsApp, Cloudinary, validation
public/          index.html, admin.html, certificate.html, logo.png, favicon.png, robots.txt, _headers
```

## Your data
Nothing in the existing collections is deleted or renamed. New records are written in the same format as the old system.

New collections:
- `accounts`: logins (passwords stored only as scrambled hashes)
- `admissionrequests`, `contactenquiries`, `franchiseenquiries`, `feedback`: website forms
- `settings`: homepage numbers set by the admin
- `ratelimits`: temporary counters that stop spam and password guessing

Courses may gain two optional fields when edited in the admin panel: `eligibility` and `careerScope`.

---

## Setup (one time)

### 1. Back up first
Atlas's free plan has no automatic backup. In MongoDB Compass, export every collection
(**Export Collection → JSON**) and keep the files safe.

### 2. MongoDB Atlas
1. **Database Access → Add New Database User**: username `gci-website`, **Autogenerate Secure Password** (save it),
   privileges **readWrite** on `GuruComputerWebsite` only.
2. **Network Access → Add IP Address → Allow Access from Anywhere** (`0.0.0.0/0`). Cloudflare has no fixed IP address; the strong password protects the database.
3. **Connect → Drivers**: copy the connection string and put the password in place of `<db_password>`.
4. Recommended indexes (Atlas → Collection → Indexes → Create):
   - `ratelimits`: `{ "expireAt": 1 }` with option `{ expireAfterSeconds: 0 }` (old counters delete themselves)
   - `students`: `{ "certificates.certificateId": 1 }`
   - `feereceipts`: `{ "studentId": 1 }`
   - `contactenquiries`, `franchiseenquiries`, `admissionrequests`: `{ "mobileNo": 1, "createdAt": -1 }`

### 3. Login codes (at least one)
- **Email (Brevo, free 300/day):** add and confirm a sender email, then create an API key.
- **WhatsApp (Meta Cloud API):** create an **Authentication** template `gci_login_otp` (Copy code button, 10-minute expiry),
  copy the Phone number ID, and create a permanent System User token.

### 4. Documents and course pictures: Cloudinary
Cloudinary dashboard → Settings → API Keys. Without these, admissions still work but documents are not saved,
and course pictures cannot be uploaded (courses then show an icon). Course pictures you already had in the old
system (`thumbnail` field) show automatically. To add or change one: **Admin → Courses → Edit → Course picture**.

### 5. Put the code on GitHub
New **private** repository → **uploading an existing file** → drag in all files and folders from this project → Commit.

### 6. Deploy on Cloudflare
1. **Workers & Pages → Create → Import a repository** → choose the repository → **Deploy** (Cloudflare installs the MongoDB driver).
2. Worker → **Settings → Variables and Secrets**: add the secrets listed in `.env.example`
   (`MONGODB_URI`, `SESSION_SECRET`, `ADMINS`, plus email and/or WhatsApp keys, and Cloudinary if used).
3. **Deployments → Redeploy** so the secrets take effect.
4. **Domain:** add `gurucomputerinstitute.com` to Cloudflare (change the nameservers at your domain company), then
   Worker → **Settings → Domains & Routes → Add Custom domain** → `www.gurucomputerinstitute.com` and `gurucomputerinstitute.com`.
   The bare domain redirects to `www` automatically.
5. Remove the old static site from wherever it is hosted now, so only the Worker serves the domain.

### 7. Check after going live
- `/` shows your real courses and numbers; `/courses/<any course>` opens; `/nope` shows "Page Not Found".
- `/login` with a real Enrollment ID: the code arrives; after setting a password you land on `/dashboard`.
- `/dashboard/fees` shows receipts; `/verify-certificate?id=<old certificate no.>` shows "genuine".
- `/admin` with your admin ID; send yourself a test contact enquiry and see it under **Enquiries**.
- `https://www.gurucomputerinstitute.com/sitemap.xml` loads; submit it in Google Search Console.

## Local testing (optional, needs Node.js 20+)
```
npm install
copy .env.example to .dev.vars and fill it in (you can add DEV_SHOW_OTP=1 here only)
npx wrangler dev
```

## Free plan limit to watch
Cloudflare's free Workers plan allows 10 ms of processing per request. Page views and most API calls stay well
under it. Logging in (password checking) and opening a database connection can go over it now and then; Cloudflare
allows occasional overruns. If the Worker logs show "exceeded CPU time limit" errors or logins fail, switch to the
Workers Paid plan ($5/month), which removes this limit. No code change is needed.
