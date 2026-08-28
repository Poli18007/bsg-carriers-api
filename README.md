# BSG Carriers — Backend API

Node/Express API behind the static marketing site. **Phase 1:** receives the
contact and carrier-onboarding forms, stores every submission in MySQL, notifies
BSG by email + Slack, and serves a staff admin dashboard. Runs as a GoDaddy
cPanel Node.js app on its own subdomain, **`api.bsgcarriers.com`**, deliberately
separate from the static site so the site's deploy (which wipes `public_html`
and overwrites `.htaccess`) never touches it.

See the full plan at `../.claude/plans/groovy-hugging-scone.md`.

## Layout
```
app.js                 Passenger entry — creates the Express app and listens
schema.sql             tables: submissions, staff_users, notifications_log (+ sessions, auto)
.env.example           every env var (set the real values in the cPanel UI, not a file)
src/db.js              mysql2 pool
src/lib/validate.js    honeypot + field validation + contact/onboarding classification
src/lib/notify.js      email (nodemailer) + Slack (webhook), best-effort, logged
src/lib/auth.js        bcryptjs, sessions, requireLogin / requireRole
src/routes/leads.js    POST /leads (public, CORS-locked, rate-limited)
src/routes/admin.js    /admin dashboard (login, list/search, detail, CSV, staff mgmt)
views/                 EJS admin pages
scripts/init-db.mjs    load schema.sql
scripts/create-admin.mjs   seed / reset a staff account
```

## Endpoints
| Method | Path | Who | What |
|---|---|---|---|
| GET | `/health` | anyone | `{ok, ts}` uptime + DB check |
| POST | `/leads` | the website | store a submission, notify. Honeypot + rate limit + validation |
| GET | `/admin` | staff | dashboard: list, search, filter, KPIs |
| GET/POST | `/admin/login`, `/admin/logout` | | session auth (CSRF-protected) |
| GET | `/admin/leads/:id` | staff | one submission; auto-marks `new`→`read` |
| POST | `/admin/leads/:id/status` | staff | new / read / archived |
| GET | `/admin/leads.csv` | staff | CSV export of the current filter |
| GET/POST | `/admin/users` | **admin role** | list / add staff; disable accounts |

## Local development
Needs a MySQL to point at (a Docker one is easiest):
```bash
docker run -d --name bsg-mysql -e MYSQL_ROOT_PASSWORD=rootpw \
  -e MYSQL_DATABASE=bsgapi -e MYSQL_USER=bsgapi -e MYSQL_PASSWORD=bsgapipw \
  -p 3399:3306 mysql:8
cp .env.example .env         # set DB_PORT=3399, DB_HOST=127.0.0.1, DB_USER/PASS/NAME=bsgapi
npm install
npm run init-db              # load schema.sql
npm run create-admin -- "Your Name" you@bsgcarriers.com 'a-strong-password' admin
npm start                    # http://localhost:4000  → /admin
```
The site's `ui_kits/website/site-config.js` auto-targets `http://localhost:4000`
when served from localhost, so the full stack works with no edits.

## Deploy to GoDaddy cPanel (one-time)
1. **Subdomain** — Domains → create `api.bsgcarriers.com` (note its docroot,
   e.g. `/home/tpvpzrbok576/api.bsgcarriers.com`).
2. **Database** — MySQL® Databases → create a fresh DB + user, add the user to the
   DB with **All Privileges**. Then phpMyAdmin → that DB → SQL → paste `schema.sql` → Go.
3. **Mailbox** — Email Accounts → create `no-reply@bsgcarriers.com` (its password
   is `SMTP_PASS`).
4. **Node app** — Setup Node.js App → Create:
   - Node version: 18 or 20 · **Application mode:** Production
   - **Application root:** `bsg-api`  (i.e. `/home/tpvpzrbok576/bsg-api` — NOT under `public_html`)
   - **Application URL:** `api.bsgcarriers.com`
   - **Startup file:** `app.js`
5. **Upload the code** to the application root (`/home/tpvpzrbok576/bsg-api`) over
   FTP with the **main** cPanel account — everything here **except** `node_modules/`
   and `.env` (`.gitignore` already excludes them).
6. **Environment variables** — in the Node app panel, add every key from
   `.env.example` with real values. `ALLOWED_ORIGIN=https://bsgcarriers.com`,
   `NODE_ENV=production`. Do **not** upload a `.env` file.
7. **Run NPM Install** (button in the panel), then **Restart**.
8. **Seed the first admin** — the panel's "Run JS script" with `scripts/create-admin.mjs`,
   or a terminal after `source ~/nodevenv/bsg-api/<ver>/bin/activate`:
   `node scripts/create-admin.mjs "Name" name@bsgcarriers.com 'password' admin`.
9. **Verify** — `https://api.bsgcarriers.com/health` → `{"ok":true}`; log in at
   `https://api.bsgcarriers.com/admin`.

## Cut the website over to the API (after the API verifies live)
1. In `ui_kits/website/site-config.js` set `launchStatus: 'READY'`.
2. `npm run package` (from the repo root), then deploy `dist/` to `public_html`
   (see `../DEPLOY-GODADDY.md`).
3. Submit both real forms on bsgcarriers.com → confirm a `submissions` row, the
   email, the Slack message, and that it appears in `/admin`.

## Redeploys
Upload changed files to the app root → **Restart** in the cPanel panel. The
static-site deploy never touches this directory.

## Notes
- **Secrets live in the cPanel env UI, never on disk** in a browsable dir.
- `bcryptjs` (pure JS) and `mysql2` are used specifically to avoid native
  compilation on shared hosting.
- Sessions are stored in MySQL, so a Passenger process recycle doesn't log
  everyone out.
- Notifications are best-effort and fire **after** the row is saved — a mail or
  Slack outage never loses a lead; each attempt is written to `notifications_log`.
