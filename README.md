# Guru Computer Institute: website + backend

One Cloudflare Worker serves the website (`public/index.html`) and the backend (`/api/*`).
The backend reads your existing MongoDB Atlas database `GuruComputerWebsite`.

**Logging in and viewing never change your old records.** The website adds two new collections:
- `accounts`: login passwords (stored scrambled) and OTP codes
- `admissionrequests`: admission forms sent from the website

The **admin panel** (`/admin.html`) adds and updates students, fees and certificates in
`students`, `admissions`, `fees` and `feereceipts`, in exactly the same format as the old system.

## What works now
- Student / franchise login: Enrollment ID → first time: OTP on WhatsApp + email → create password
- Forgot password (OTP on email), lock for 15 minutes after 5 wrong passwords
- Student dashboard: all courses, fee paid/pending per course (from fee receipts), receipts, certificates
- Franchise dashboard: centre details, number of students, franchise certificate validity
- Certificate verification for old student certificates and franchise certificates
- Course list, course pages and fee boxes loaded from the `courses` collection (public courses only)
- Online admission form saved to `admissionrequests` (and sent on WhatsApp as before)

**Admin panel** at `yourdomain.com/admin.html`:
- Home: students, admissions this month, fees collected this month, total pending, website requests
- Website requests: Admit (fills the admission form), Contacted, Not interested
- New admission: next Enrollment ID (`GCI2022` + number) and roll number, discount, documents
  (photo, marksheet, ID proof saved privately on Cloudinary), duplicate check, send ID on WhatsApp
- Students: search by name, ID, mobile or father's name; filter by centre; pending fee per student
- Student page: edit details, add another course, take fee (receipt `GCI000-NNN`, printable,
  send on WhatsApp), issue certificate (`CERT-XXXXXX`, printable page with QR code)
- Older records with a course but no fee entry are handled: pending is worked out from their receipts

---

## Setup (one time)

### 1. MongoDB Atlas
1. **Database Access → Add New Database User**
   - Username: `gci-website`, click **Autogenerate Secure Password** and copy it somewhere safe.
   - Database User Privileges → **Specific Privileges** → `readWrite` on database `GuruComputerWebsite`.
2. **Network Access → Add IP Address → Allow Access from Anywhere** (`0.0.0.0/0`).
   Cloudflare does not use fixed addresses, so this is needed. The strong password protects the database.
3. **Clusters → Connect → Drivers** → copy the connection string. Put your password in place of `<db_password>`.
   It looks like: `mongodb+srv://gci-website:PASSWORD@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`
4. (Optional, makes lookups faster) **Indexes** → create:
   - `students`: `{ "certificates.certificateId": 1 }`
   - `franchises`: `{ "certificates.certificateId": 1 }`
   - `feereceipts`: `{ "studentId": 1 }`

### 2. Brevo (sends the OTP emails, free: 300 emails/day)
1. Sign up at brevo.com.
2. **Senders, Domains & Dedicated IPs → Senders → Add a sender**: the email the OTP comes from
   (e.g. `info@gurucomputerinstitute.com` or your Gmail). Confirm it from the email Brevo sends.
   Using an email on your own domain (and authenticating the domain in Brevo) keeps OTPs out of spam.
3. **SMTP & API → API Keys → Generate a new API key**. Copy it.

### 2b. WhatsApp OTP (Meta WhatsApp Cloud API)
The OTP is sent on WhatsApp **and** email together. If one fails, the other still works.
Students with no email still get the code on WhatsApp (to `mobileNo`, as +91).

1. **Create the OTP template.** WhatsApp Manager → **Message templates → Create template**
   - Category: **Authentication**
   - Name: `gci_login_otp`
   - Language: **English** (language code `en`; if you pick "English (US)" use `en_US`)
   - Code delivery: **Copy code**. Tick "Add security recommendation", expiry **10 minutes**.
   - Submit. Authentication templates are usually approved within minutes.
2. **Phone number ID.** Meta for Developers → your app → **WhatsApp → API Setup** → copy the **Phone number ID**
   (a long number, not your phone number).
3. **Permanent access token.** The token on the API Setup page expires in 24 hours, so make a permanent one:
   Business Settings → **Users → System users → Add** (Admin) → **Assign assets**: your WhatsApp account (full control)
   → **Generate new token** → expiry **Never** → permissions `whatsapp_business_messaging` and
   `whatsapp_business_management`. Copy it.
4. Add these as Cloudflare **Secrets** in step 4 below:

| Name | Value |
|---|---|
| `WA_ACCESS_TOKEN` | the permanent token |
| `WA_PHONE_NUMBER_ID` | the Phone number ID |
| `WA_OTP_TEMPLATE` | `gci_login_otp` |
| `WA_OTP_LANG` | `en` (or `en_US`) |

Meta charges a small fee per authentication message; check the rate in WhatsApp Manager → Insights/Billing.
If your template has no "Copy code" button, also add a variable `WA_OTP_BUTTON` = `0`.

### 2c. Admin login
Add a Cloudflare **Secret** named `ADMINS` with this text (change the values):

```
[{"id":"GCI_ADMIN_LOKESH","name":"Lokesh","email":"your@email.com","mobile":"9389824310"}]
```

- `id` is what you type on the admin login screen (not case-sensitive).
- The OTP goes to that email and WhatsApp number. Then you create your password.
- To add another admin, add another `{...}` inside the brackets, separated by a comma.
  Removing someone from the list logs them out immediately.

### 2d. Cloudinary (documents)
Your old documents are on Cloudinary (cloud `dlm14evj4`). To save new ones there too:
Cloudinary dashboard → **Settings → API Keys** → copy the API key and API secret, and add these Secrets:

| Name | Value |
|---|---|
| `CLOUDINARY_CLOUD_NAME` | `dlm14evj4` |
| `CLOUDINARY_API_KEY` | the API key |
| `CLOUDINARY_API_SECRET` | the API secret |

New documents are saved as **private** files (only the signed link opens them).
Without these, admissions still work; the panel just does not save documents.

### 3. Put the code on GitHub (no software to install)
1. Create a free account at github.com → **New repository** → name `guru-computer-institute` → **Private** → Create.
2. Click **uploading an existing file** and drag in everything from this folder
   (`src`, `public`, `package.json`, `wrangler.jsonc`, `README.md`, `.gitignore`). Click **Commit changes**.

### 4. Deploy on Cloudflare
1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → connect GitHub → choose the repository.
2. Keep the defaults (build/deploy command `npx wrangler deploy`) → **Deploy**.
   Cloudflare installs the MongoDB driver and publishes the site at `guru-computer-institute.<you>.workers.dev`.
3. Open the Worker → **Settings → Variables and Secrets → Add**, type **Secret**, and add:

| Name | Value |
|---|---|
| `MONGODB_URI` | the connection string from step 1.3 |
| `SESSION_SECRET` | a long random text, at least 32 characters (use a password generator; never share it) |
| `BREVO_API_KEY` | the key from step 2.3 |
| `MAIL_FROM` | the sender email you added in Brevo |

4. **Deployments → Retry / Redeploy** so the secrets take effect.
5. Custom domain: Worker → **Settings → Domains & Routes → Add → Custom domain** → `yourdomain.com`
   (your domain must be added to Cloudflare first).

### 5. Back up first
Atlas's free plan has no automatic backup. Before the first admission in the new panel, export each collection
(MongoDB Compass → collection → **Export Collection → JSON**) and keep the files safe.

### 6. Test
- Open `/admin.html`, log in with your admin ID, and check the numbers on Home.
- Open the site: the course list should show your real courses from the database.
- Student Login → enter a real Enrollment ID that has your email address → you should get the code.
- Certificate Verification → enter an old certificate number (e.g. from a student record).

## Updating later
Edit files on GitHub (or upload new ones). Cloudflare redeploys automatically after each commit.
