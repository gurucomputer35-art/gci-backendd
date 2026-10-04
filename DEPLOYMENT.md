# Deployment guide: Guru Computer Institute on Cloudflare (free)

One Cloudflare Worker runs everything: the website, student portal, admin panel and the backend API,
connected to your existing MongoDB Atlas database `GuruComputerWebsite`. Nothing in the database is deleted.

**Upload the full project (`gci-deploy-full.zip`)**. The backend (`src/`) serves the website files in `public/`,
so both folders must be in the same repository.

Time needed: about 45 minutes. Cost: ₹0 (Cloudflare free plan; see "If logins fail" at the end).

---

## Step 0: Back up the database (5 min)
MongoDB Compass → connect → for every collection: **Export Collection → JSON** → save the files in a safe folder.

## Step 1: MongoDB Atlas (10 min)
1. **Database Access → Add New Database User**
   - Username: `gci-website`
   - **Autogenerate Secure Password** → copy and save it
   - Built-in role / privilege: **readWrite** on database `GuruComputerWebsite`
2. **Network Access → Add IP Address → Allow Access from Anywhere** (`0.0.0.0/0`) → Confirm.
   Cloudflare has no fixed IP; the strong password protects the database.
3. **Database → Connect → Drivers** → copy the connection string. Replace `<db_password>` with the password from step 1.
   This full line is your `MONGODB_URI`. Keep it secret.
4. (Recommended) Collection → **Indexes → Create Index**:
   - `ratelimits`: `{ "expireAt": 1 }`, options `{ "expireAfterSeconds": 0 }`
   - `students`: `{ "certificates.certificateId": 1 }`
   - `feereceipts`: `{ "studentId": 1 }`

## Step 2: Login codes (OTP) (10 min, at least one)
**Email: Brevo (free, 300 emails a day)**
1. brevo.com → sign up → **Senders, Domains & Dedicated IPs → Senders → Add a sender** (`info@gurucomputerinstitute.com`) → confirm the email.
2. **SMTP & API → API Keys → Generate a new API key** → copy. This is `BREVO_API_KEY`.

**WhatsApp: Meta Cloud API** (you already have it)
1. WhatsApp Manager → **Message templates → Create** → category **Authentication** → name `gci_login_otp`
   → button **Copy code** → code expiry 10 minutes → submit and wait for approval.
2. Meta app → WhatsApp → **API Setup**: copy the **Phone number ID** (`WA_PHONE_NUMBER_ID`).
3. Business Settings → **System users** → generate a permanent token with `whatsapp_business_messaging` (`WA_ACCESS_TOKEN`).

## Step 3: Cloudinary (5 min, for course pictures and admission documents)
cloudinary.com → **Settings → API Keys** → copy Cloud name, API key, API secret.

## Step 4: Put the code on GitHub (5 min)
1. github.com → **New repository** → name `gci-website` → **Private** → Create.
2. Unzip `gci-deploy-full.zip` on your computer.
3. In the repository: **uploading an existing file** → drag **everything inside** the unzipped folder
   (folders `src` and `public`, and `package.json`, `wrangler.jsonc`, `README.md`, `.env.example`, `.gitignore` …) → **Commit changes**.
   Check that `wrangler.jsonc` is at the top level of the repository, not inside another folder.

## Step 5: Create the Worker on Cloudflare (5 min)
1. dash.cloudflare.com → **Workers & Pages → Create → Import a repository** → connect GitHub → choose `gci-website`.
2. Build settings: leave as they are (Deploy command `npx wrangler deploy`) → **Deploy**.
   Cloudflare installs the MongoDB driver itself. Wait for "Success".

## Step 6: Add the secrets (5 min)
Worker → **Settings → Variables and Secrets → Add** → type **Secret** for each:

| Name | Value |
|---|---|
| `MONGODB_URI` | the connection string from Step 1 |
| `SESSION_SECRET` | any long random text, 40+ characters (e.g. type random letters and numbers) |
| `ADMINS` | `[{"id":"GCI_ADMIN_LOKESH","name":"Lokesh","email":"your-email","mobile":"your-10-digit-mobile"}]` |
| `BREVO_API_KEY` | from Step 2 |
| `MAIL_FROM` | `info@gurucomputerinstitute.com` (the confirmed Brevo sender) |
| `WA_ACCESS_TOKEN` | from Step 2 (if using WhatsApp) |
| `WA_PHONE_NUMBER_ID` | from Step 2 (if using WhatsApp) |
| `WA_OTP_TEMPLATE` | `gci_login_otp` |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | from Step 3 |

Then **Deployments → … → Redeploy** (secrets apply only after a redeploy).
Open the `*.workers.dev` link Cloudflare shows and check that the courses load.

## Step 7: Connect your domain (15 min + waiting)
1. Cloudflare → **Add a domain** → `gurucomputerinstitute.com` → Free plan.
2. Cloudflare shows two **nameservers**. At your domain company (where you bought the domain) → DNS / Nameservers → replace the old ones with these two.
   Activation takes from a few minutes up to 24 hours; Cloudflare emails you.
3. Worker → **Settings → Domains & Routes → Add → Custom domain** → `www.gurucomputerinstitute.com`, then again for `gurucomputerinstitute.com`.
   If Cloudflare says a DNS record already exists, delete that old record (DNS → Records) and try again.
4. Turn off the old hosting so only the Worker serves the domain.

## Step 8: Check the live site
- [ ] `https://www.gurucomputerinstitute.com/courses` shows your real courses (with pictures if they had one)
- [ ] `/nope` shows "Page Not Found"
- [ ] `/login` with a real Enrollment ID: code arrives on email/WhatsApp → set password → dashboard opens
- [ ] `/dashboard/fees` shows the receipts
- [ ] `/verify-certificate` with an old certificate number says genuine
- [ ] `/admin` with your admin ID works; Courses → Edit → add a picture → Save
- [ ] Send a test contact enquiry; it shows in Admin → Enquiries
- [ ] Google Search Console → add the site → submit `https://www.gurucomputerinstitute.com/sitemap.xml`

## Updating later
Change files on GitHub (upload the new file with the same name → Commit). Cloudflare redeploys automatically in about a minute.

## If something goes wrong
| Problem | Fix |
|---|---|
| "We cannot reach our records right now" | `MONGODB_URI` wrong, password has special characters not encoded, or Atlas Network Access missing `0.0.0.0/0` |
| "The website is not fully set up yet" | `SESSION_SECRET` missing or shorter than 32 characters → fix → Redeploy |
| Login code never arrives | Brevo sender not confirmed / wrong `BREVO_API_KEY`; WhatsApp template not approved yet |
| Admin ID says "No student or centre found" | Check `ADMINS` is valid JSON (straight quotes `"`, square brackets) → Redeploy |
| "Course pictures need the Cloudinary keys" | Add the three `CLOUDINARY_*` secrets → Redeploy |
| Logins fail sometimes, logs say "exceeded CPU time limit" | Workers Paid plan ($5/month); no code change |
| Domain still shows the old site | Nameservers not changed yet, or the old DNS record still exists |

Never put passwords or keys in GitHub files, chat or screenshots. They go only in Cloudflare → Variables and Secrets.
