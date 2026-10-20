# Persuratan — Monthly Letter Register

Structured 2026 letters, atomic dated number allocation, and monthly Google Sheets
projection with a persisted retry queue.

Built with Next.js 15 (App Router), TypeScript, Tailwind CSS, Supabase
(PostgreSQL + Realtime) and the Google Sheets API. Deploys to Vercel.

---

## Table of contents

1. [How it works](#how-it-works)
2. [Setup](#setup)
3. [Supabase Realtime](#supabase-realtime)
4. [Google Service Account setup](#google-service-account-setup)
5. [Roles and access](#roles-and-access)
6. [The first Superadmin](#the-first-superadmin)
7. [API reference](#api-reference)
8. [Deployment to Vercel](#deployment-to-vercel)
9. [Design decisions and trade-offs](#design-decisions-and-trade-offs)
10. [Troubleshooting](#troubleshooting)

---

## How it works

KD Surat (from **Acuan No Surat**), KD Satker, Hal, Tujuan Surat and Ket are required.
After a valid KD Surat selection, the form shows its catalog hierarchy as separate
indented rows, root first (for example `000 UMUM`, `000.1 LAMBANG`, then
**`000.1.1 Lambang provinsi`**). Only the selected row is bold. Missing catalog
parents are omitted, and long descriptions wrap within the field.
Tujuan Surat must contain non-whitespace text, up to 500 characters.
The creation form labels these fields **Perihal Surat** and **Keterangan**; API
keys remain `hal` and `ket`. Perihal Surat has no placeholder. The redundant
readonly Nomor Surat field is removed; automatic allocation and the allocated
number in the success message remain unchanged. Admin/user form smoke passed
with isolated API responses at desktop/mobile widths, alongside unit, type and
zero-warning lint checks. No production Supabase or Sheets changes were made.
New forms and successful submissions leave KD Satker and Ket unselected.
Changing the date clears Ket. Today WIB allows SRIKANDI/EOFFICE/MANUAL;
past and future dates allow only **MANUAL**, explicitly selected by the user.
API validation and the SQL content trigger enforce the same rule.
CAT is unavailable for new submissions or content edits. Existing CAT archives
and empty destinations remain readable and syncable; editing requires the new fields.
The interface and authored user messages use Bahasa Indonesia; machine codes,
account names and API keys are unchanged.
HARI INI uses the server's WIB date. The official number is assigned only after
submission; `documents.id` is a private numeric row key, not the letter number.

```text
1. First use: import existing 2026 month tabs B:M into the dated slot ledger.
2. create_registered_document(): reserve + allocate + insert in one SQL transaction.
3. Project B:M values/geometry, then E-only fills, in two atomic Google batches under one writer lease.
4. Mark the same document version synced, or persist the failure for retry.
```

PostgreSQL is the only allocator. Google failures never undo a saved letter.
The allocator serializes concurrent submissions with a transaction-scoped lock:
ordinary numbers and emergency suffixes share a unique official-number constraint.

- Backdates take the first unused slot **on that date**.
- A future submission fixes the configured daily ordinary-slot total for today and
  each intervening unfixed date, including already-used slots. Without a date-specific
  plan, the target day remains dynamic until a later range exists.
- At **23:59 WIB**, closing leaves the configured minimum unused slots on open days
  without a date-specific plan. Fixed days receive no additional slots. Missed runs catch up.
- Earlier ranges cannot grow across a later range. An exhausted date returns
  `DAY_FULL`; explicit admin/superadmin confirmation and a reason allocate its
  latest base number plus `.a`, `.b`, … `.z`, `.aa`, ….
- Dates without a historical numbered range return `DAY_MISSING`, not an invented
  number. Imported numeric suffixes such as `3939.1` remain valid and searchable.
- The configured workbook/year is **2026 only**. Numbering does not reset by month;
  the next year's deployment must retain the high-water mark and use a new workbook.

Admin/superadmin configure **Pengaturan Nomor Surat** (`/admin/register-settings`):

| Setting | Initial value | Allowed values |
|---|---:|---:|
| Minimum unused numbers when a day closes | 15 | 1–50 |
| Ordinary-slot total per intervening day for future submissions | 45 | 1–150 |
| Date-specific ordinary-slot total | No override | 1–400 |

Saving a setting or date plan allocates nothing. Plans take precedence over both
defaults when the date is processed by registration/closing. A plan of 200 on
12 October uses the future-day default on 11 and 13 October when registering
14 October. Emergency suffixes do not count toward the planned ordinary total.
Existing fixed/closed ranges are never resized or renumbered. New/edited plans
must be for today or a future 2026 date and cannot shrink an existing range.
Any plan, including a past/locked one, may be deleted as configuration only:
allocated numbers stay unchanged. Incompatible pre-import plans stop import
atomically with an actionable conflict; remove the conflicting plan before retrying.

Import preserves existing entries and legacy checkbox-column annotations. Missing
dates after the last imported day are closed automatically. With the initial
defaults, an import ending at 4464 on 31 August reserves 15 numbers for each of
1 September–5 October: the first ordinary 6 October number is **4990**, not 4465.

Legacy application records without a letter date remain readable, but cannot be
edited, resynced or deleted without inventing an original register date.

Only numbered **E / Nomor Surat** cells receive **#FFE599** when occupied and
**#EA9999** when empty, in the website and Google Sheets. Existing annotations
also count as occupied; a prefilled satker, slashes or number alone do not.
The writer preserves source styles and native conditional text formatting,
replacing only its own tagged color rules. Unchanged rows retain their formats,
validation, heights and merges without retransmitting them.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Create the database

Supabase Dashboard → **SQL Editor** → **New Query**. Fresh install:

1. `supabase/schema.sql` — base tables, auth and RLS.
2. `supabase/migrations/20261006_letter_register.sql` — dated allocator and catalog.
3. `supabase/migrations/20261007_document_delete.sql` — safe deletion, deferred slot release and private document reads.
4. `supabase/migrations/20261007_form_revisions.sql` — optional destination, WIB Ket rules and recoloring of previously synced days.
5. `supabase/migrations/20261008_required_destination.sql` — mandatory destination and CAT removed from new/content-edited letters; archives unchanged.
6. `supabase/migrations/20261009_register_settings.sql` — configurable closing/future reserves and per-date totals, preserving allocated ranges.
7. `supabase/migrations/20261010_superadmin_invariant.sql` — atomic protection of the last approved superadmin under concurrent role/status/deletion requests.
8. `supabase/migrations/20261011_document_sort.sql` — service-only, read-only natural-number sorting view (PostgreSQL 15+); no stored numbers or allocator state change.
9. `supabase/migrations/20261012_register_tail_trim.sql` — receipt-backed trailing-reserve retirement, multi-month clearing and confirmed official-counter rewind.
10. `supabase/migrations/20261013_post_trim_daily_reserves.sql` — restore elapsed daily closing reserves before new creation and queue cleanup of previously trimmed Sheets.
11. `supabase/migrations/20261014_single_superadmin_approvals.sql` — one protected superadmin and atomic, scoped administrator registration decisions.
12. `supabase/seed.sql` — bootstrap the sole superadmin once (see [The first Superadmin](#the-first-superadmin)).

**Existing project:** apply any unapplied migrations in the order above before
deploying this code. Do not rerun schema/seed. A REST service-role key cannot apply
SQL DDL; use SQL Editor or a direct database connection.

### 3. Configure the environment

Create `.env.local` with these required variables; keep it out of version control:

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `CRON_SECRET`,
`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `GOOGLE_SHEET_ID`.

The checkout has no `.env.example`. See [Google Service Account setup](#google-service-account-setup)
for the private key format. The workbook must contain **Acuan No Surat** and the
**AGUSTUS** B:M template. Month tabs are selected automatically; the old
`GOOGLE_SHEET_NAME` setting is no longer used.

Generate the two secrets:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 48   # CRON_SECRET
```

### 4. Run

```bash
npm run dev
```

Open http://localhost:3000.

---

## Document search updates

**Buat Nomor Surat** is creation-only (`/dashboard` for users, `/admin` for administrators).
**Cari Surat** (`/documents`) is a separate sidebar page for every approved role.
It polls the authorized list/queue APIs every 15 seconds while visible and supports
manual **Muat ulang**. Unsaved edits survive polling; a changed authorization scope
clears the old rows/editor. There is no browser Supabase client or Realtime subscription.

**Tanggal dibuat** follows Nomor Surat and shows the current document's `created_at`
date and time in WIB, not its letter date or last synchronization. Reused numbers
show the new document's creation time; unavailable legacy timestamps are labeled.
Sort Nomor Surat, Tanggal dibuat or Tanggal in either direction; the API orders the
entire filtered set before pagination, with stable ID ties and null dates last.
Number sorting is numeric/natural, including historical numeric and emergency
alphabetic suffixes. The initial order remains newest creation first.
Desktop columns wrap; narrow screens use fully labeled stacked rows. All fields,
archive details, full synchronization errors and inline editing remain available.
On small screens the existing navigation wraps above content instead of consuming
the sidebar's desktop width. Row actions use MIT Heroicons inline SVGs (no package):
edit, green refresh and red delete, with accessible names, focus and 44px targets.

The deletion migration removes `documents_anon_select`: public anon/authenticated
keys must not read letter contents directly. The API rechecks approval and enforces
ownership on list, edit, re-sync, delete and queue responses. Admin/superadmin see all
application letters; ordinary users see only their own.

Hapus removes the private document and queues clearing of its register contents.
Deleting the last occupied letter retires every unused trailing slot, including
future-day reserves. After every affected monthly projection is acknowledged,
those slots are removed and the official counter rewinds to the surviving frontier.
Example: delete 6226 on 3 November → keep 6181 on 2 November and remove all unused
6182+; then delete 6181 → keep 5057 on 8 October and remove all unused 5058+.
Existing letters/imported occupied rows never change numbers; private IDs never rewind.
Deleting a middle letter retains its number/date for reuse after clearing.
HTTP202 means clearing is pending; HTTP200 with `trimmed: true` confirms removed
tail slots, while `trimmed: false` confirms ordinary original-date reuse.
Persistent receipts are keyed by private document ID, so missing/reused slot numbers
cannot masquerade as confirmation. **Sinkronkan ulang semua**/cron repairs pending
clearing, including all affected months. Number extension is held until retirement
finishes; original occupied ranges and unchanged gaps remain protected.
Trimmed days do not regrow immediately through deletion acknowledgement or cron.
Before explicit creation, elapsed trimmed dates are restored using current closing
minimums (existing unused slots count) or saved custom totals, including the surviving
frontier date. Empty open future dates resume configured future reservations.
Occupied later ranges block restoration instead of silently renumbering letters.
With 5056 unused and 5057 occupied on 8 October, minimum 10 restores nine additional
slots there and ten for each 9–13 October; creation on 14 October receives 5117.
Retired B:M cells clear values, formatting/borders, checkbox validation and notes.
Live relocated notes/styles, unmanaged columns and the August template remain.
Apply migration13 after12 before deploying this correction, then use Sinkronkan ulang
semua to clean previously acknowledged residue. The existing 5058 must be deleted
through the application and cleared successfully before recreation; no occupied
number is changed automatically. No production database/Sheets edits were performed.

---

## Google Service Account setup

### Create the service account

1. [Google Cloud Console](https://console.cloud.google.com/) → create or pick
   a project
2. **IAM & Admin** → **Service Accounts** → **Create service account**
3. Skip the optional steps, then **Create JSON key**
4. Download the `.json` file

### Share the spreadsheet

This is the step people miss: a service account has its own Google identity and
**cannot see a spreadsheet just because you can**.

1. Open the Google Sheet
2. **Share** → add the service account's email (the `client_email` field, e.g.
   `persuratan-sync@your-project.iam.gserviceaccount.com)
3. Give it **Editor** permission

### Enable the API

**APIs & Services** → **Library** → search **Google Sheets API** → **Enable**.

### The private key format

`.env` files cannot contain real newlines, so the PEM is stored with literal
`\n` escape sequences and un-escaped at runtime:

```env
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBK...\n-----END PRIVATE KEY-----\n"
```

Three things that matter:

- **Keep the surrounding double quotes**, otherwise dotenv truncates the value
  at the first space or `#`.
- **Never paste real line breaks.** The Vercel dashboard mangles them. Paste
  the same single-line `\n` form.
- `src/lib/google-sheets.ts` does `.replace(/\\n/g, '\n')` at the boundary. If
  your secret manager preserved real newlines, that replace is a no-op and
  nothing breaks.

The sheet ID is the part between `/d/` and `/edit` in the sheet URL.

---

## Roles and access

| Role | Portal | Can do |
|---|---|---|
| `user` | `/dashboard`, `/documents` | Create letters; search, edit, re-sync and delete own dated submissions; edit profile |
| `admin` | `/admin`, `/documents`, `/admin/users` | Manage letters/satkers/settings/audit; approve or reject only pending ordinary-user registrations |
| `superadmin` | `/admin`, `/documents`, `/admin/users` | Admin capabilities plus creating/managing user/admin accounts and promoting user to admin; root account protected |

Registration always creates `role='user'`, `status='pending'` — both hardcoded
server-side, never read from the request body. A pending account is refused at
`/login` and redirected by middleware:

> Your account is pending administrator approval.

There is exactly one superadmin after initial bootstrap. No application account
creation or promotion can assign that role; its role/status/deletion are protected
by database guards. Root profile username/password updates remain possible.
Admins cannot change roles, create/delete accounts, or manage approved/rejected
accounts; even forged URLs and payloads cannot widen the pending-user scope.
Fresh principal/target locks and transactional audits protect concurrent decisions.

Google Drive sharing is a separate owner-managed boundary. Share the workbook only
with the service account and authorized admin/superadmin Google accounts; remove
ordinary users and public/link editing. Even administrators must allocate numbers
through the app, not manually in Sheets. Direct B:M edits can be overwritten.

### Guards against locking yourself out

The superadmin API refuses, with a 409 or 400:

- demoting your own account
- revoking your own access
- deleting your own account
- demoting or deleting the **last** active superadmin

### Navigation

Every authenticated role uses a fixed left sidebar. There is no top navigation
bar.

| Role | Sidebar entries |
|---|---|
| `user` | Buat Nomor Surat (`/dashboard`), Cari Surat (`/documents`), Register Surat (`/register-sheet`) |
| `admin` | Buat Nomor Surat (`/admin`), Cari Surat, Register Surat, Pengaturan Nomor Surat, Permintaan Akses (`/admin/users`), Riwayat Audit |
| `superadmin` | Admin entries, with Kelola Pengguna replacing Permintaan Akses at `/admin/users` |

The identity row sits at the top right of the content area, not in the sidebar:
a user icon linking to `/profile`, then the username with the role beneath it,
then a red **Keluar** button. The row is `sticky`, so it stays reachable on long
tables without scrolling.
The sidebar brand and identity rows share a non-shrinking `h-16` (4rem) height,
so their bottom borders meet without a gap. Browser checks verified zero offset
at desktop/tablet widths, while scrolling, at 230% zoom and with enlarged text.

Management sections are **real routes**, not tabs. A refresh or browser-back
keeps you where you were — the previous implementation read `?tab=` once at mount
and silently fell back to Documents on reload. Active state is derived from
`usePathname`, so it is correct on first paint, on refresh, and on back/forward.

All authenticated pages live in the `(portal)` route group, which owns the single
session check and the single shell render. Route groups do not appear in URLs,
so `/dashboard` is still `/dashboard`.

Access is gated at three independent layers:

1. **Nav** — `AppShell` filters entries by the user's role.
2. **Route** — `(portal)/admin/layout.tsx` re-reads the database and rejects
   non-admins; `(portal)/admin/users/page.tsx` permits only approved admin/superadmin.
3. **API** — `/api/admin/users` rechecks fresh authorization: admin GET/PATCH are
   scoped to pending-user decisions; POST and broader management require superadmin.

Middleware is only a redirect layer. It reads role claims from an 8-hour JWT, so
a demotion takes effect at the route layer immediately but in middleware only
after the token expires.

Migration14 must be applied after migration13 before deploying the account API
cutover. The former `/api/superadmin/users` route is removed, not retained as a shim.
It does not rewrite users or register data; multiple existing roots cause a clear
migration failure for manual review rather than automatic demotion/deletion.
Verified with actual API/native component fixtures and disposable PostgreSQL:
singleton/profile guards, scoped decisions, role escalation denials, transactional
audits, concurrent bootstrap/decisions/principal changes under all three isolation
levels. Unit, typecheck and zero-warning lint passed; production was untouched.

---

## The first Superadmin

There is a chicken-and-egg problem: registration creates pending accounts,
pending accounts cannot log in, and approval happens in a portal that requires
an approved superadmin. On a fresh install nobody can ever log in.

`supabase/seed.sql` breaks the cycle by planting the first superadmin directly.

```bash
npm run hash-password -- "YourPassword123"
```

Copy the output and paste it into `supabase/seed.sql` in place of
`__HASH_ME__`, then run the script in the Supabase SQL editor. Sign in as
`superadmin` / that password, create real accounts from the User Management
tab, and delete the seed file.

---

## API reference

All routes are JSON. Protected routes use the `dlms_session` httpOnly cookie.

### Auth

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/register` | public | Create a pending `user` account |
| `POST` | `/api/auth/login` | public | Verify credentials, set session cookie |
| `POST` | `/api/auth/logout` | any | Clear the session cookie |

### Documents

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/documents/generate` | any approved | Validate structured fields, allocate dated number atomically, attempt projection |
| `GET` | `/api/documents/list` | any approved | Search/pagination; ordinary users forced to own rows |
| `PATCH` | `/api/documents/update` | any approved | Own registered contents (admin all); number/date immutable |
| `DELETE` | `/api/documents/delete` | any approved | `{id}`; clear contents and hold the original number until Sheets confirms |
| `POST` | `/api/documents/resync` | any approved | Retry own document or `{batch:true}` queue (admin all), including held deletions |
| `GET` | `/api/documents/resync` | any approved | Own failed/pending/deleting counts (admin all) |
| `GET` | `/api/documents/options` | any approved | Classification hierarchy, satkers, configured year and server WIB date |
| `POST` | `/api/satkers` | admin | Add a case-insensitive unique satker |

### Superadmin / profile / audit / cron

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/admin/users` | admin/superadmin | Admin: pending ordinary users only; superadmin: filtered account listing |
| `POST` | `/api/admin/users` | superadmin | Create auto-approved user/admin, never superadmin |
| `PATCH` | `/api/admin/users` | admin/superadmin | Admin: approve/reject pending users only; superadmin: manage user/admin, root protected |
| `PATCH` | `/api/profile/update` | any approved | Change own username / password |
| `GET` | `/api/audit/list` | admin | Paginated audit log; combine `search` and `action` |
| `GET` | `/api/cron/resync` | `CRON_SECRET` | Close elapsed days, project calendar changes and retry unsynced letters |

### Search behaviour

`GET /api/documents/list?search=4990` matches the official `surat_number`, not the
private row ID. Alphabetic and historical numeric suffixes also match exactly.
Other text matches Hal/title with case-insensitive `ILIKE`; `%` and `_` are escaped.
Ordinary users cannot override ownership through `createdBy` or any mutation body.
`sortBy=number|created|date` and `sortDirection=asc|desc` select database ordering.
Omitted/invalid values default to `created`/`desc`. Number sort requires
`20261011_document_sort.sql`; until applied, numeric queries return HTTP503 with
activation instructions while created/date sorting still works.

---

## Deployment to Vercel

```bash
vercel
```

Add the required environment variables above in **Settings → Environment Variables**
for all three environments. Paste `GOOGLE_PRIVATE_KEY` in single-line `\n` form.
Apply the register migration before switching production traffic to this build.

`vercel.json` schedules the cron:

```json
{
  "crons": [
    { "path": "/api/cron/resync", "schedule": "*/5 * * * *" },
    { "path": "/api/cron/resync?closeDay=1", "schedule": "59 16 * * *" }
  ]
}
```

Vercel sends `Authorization: Bearer <CRON_SECRET>`; the route compares it in
constant time and returns 401 otherwise.

The daily schedule is 23:59 WIB. `closeDay=1` cannot close early: the authenticated
route checks the WIB clock. Delayed invocations use elapsed-day catch-up.

> Five-minute scheduling requires a suitable Vercel plan (not Hobby).
> On another host, schedule the authenticated endpoint at the same intervals;
> manual retries alone cannot close empty calendar days on time.

---

## Design decisions and trade-offs

**Custom auth instead of Supabase Auth.** The approval workflow uses bcrypt and an
httpOnly session cookie. Browser reads poll guarded APIs rather than anonymous
Supabase Realtime, so letter titles/metadata do not require a public read policy.

**The database write precedes the Sheets call.** The reverse order would mean a
Google outage silently discards submissions. Data integrity over synchronous
third-party availability.

**Middleware is a redirect layer, not the security boundary.** The JWT carries
`role` and `status` for 8 hours, so a demotion would not take effect in
middleware alone. Every privileged route re-reads the user from Postgres via
`getFreshSession()`. Middleware also excludes `/api/*` from its matcher — the
auth and cron endpoints have no cookie to check, and running them through the
redirect logic would break sign-in.

**Sheets is a projection, not an append log.** A coherent SQL snapshot rebuilds
only B:M using the AGUSTUS headings, date merges, widths, formatting and checkboxes.
JULI O:Z is untouched: rows are not inserted/deleted and its existing heights are
preserved. Imported legacy text annotations in J:M are retained, not coerced away.
Retries replace the same numbered rows; edits do not append corrections or copies.

**Writers share a PostgreSQL lease.** The 240-second lease outlives Google's
[180-second request processing limit](https://developers.google.com/workspace/sheets/api/limits).
It is renewed before a batch and retained after an uncertain mutation failure.
Day revisions and document timestamps prevent stale acknowledgement; a busy writer
leaves synchronization queued rather than starting another overlapping write.

**Retries are sequential, not parallel.** Google Sheets has per-spreadsheet
rate limits. `Promise.all` over a batch is the fastest way to collect 429s and
mark healthy documents as failed.

**Deletion audit is transactional.** `DELETE_DOC` records number/date and the
tail-trim decision inside the SQL transaction; failure rolls back deletion. Other audit
writes log failures without discarding a saved letter.

**Login responses are uniform.** "No such user" and "wrong password" return the
identical 401 so usernames cannot be enumerated, and the not-found path still
runs a bcrypt compare so response timing does not leak the difference either.

---

## Troubleshooting

**A deleted number is still unavailable.** This is intentional while Sheets is
busy or failed. **Sinkronkan ulang semua** or cron retries the cleared monthly projection.
Only an acknowledgement of the current day revision releases the original-date slot.

**Every sync fails with a permission error.** The service account cannot see
the spreadsheet. Share it with the `client_email` from your key file and give
it Editor access.

**`Missing environment variable ...`** Set the missing value in `.env.local` or the deployment environment using the setup list above.
Restart the dev server after editing env files.

**`invalid_grant` / `Invalid JWT Signature`.** The private key has broken line
breaks. Re-paste it as a single line with literal `\n` and keep the quotes.

**Cron returns 401.** `CRON_SECRET` in the Vercel dashboard does not match the
value the route reads, or the Authorization header was stripped. Vercel Hobby
also only fires crons once per day.

**Sync failed but the letter exists.** Expected: the SQL transaction committed
before Google was contacted. Retry the saved letter; do not submit it again.
Retries regenerate the same monthly projection instead of appending duplicate rows.
Manual edits or other writers outside this application are not coordinated.

**The official number jumps.** Reserved unused slots are deliberate, not lost IDs:
future/closing reserves use the admin-configured defaults (initially45/day and15 unused/day), unless a custom total applies.
`documents.id` is internal and must not be treated as the official number.

---

## Scripts

```bash
npm run dev            # dev server
npm run build          # production build
npm start              # serve the production build
npm run typecheck      # tsc --noEmit
npm run lint           # eslint, zero warnings tolerated
npm run hash-password -- "pw"   # generate a bcrypt hash for seed.sql
```

## Register Surat (read-only)

Open **Register Surat** in the sidebar (`/register-sheet`). All approved
user/admin/superadmin accounts can read the complete register, including imported
letters and other users' entries; this access was explicitly approved. It does not
grant mutation access to others' application letters.

Choose a month and date in 2026. The table reads actual Google Sheets **B:M**,
including unused numbered rows, source text/annotations, requested number-cell fills,
merged headers, column widths, row heights and read-only checkboxes. It does not
allocate numbers, edit cells, publish the workbook or use Apps Script.

Visible pages refresh 10 seconds after each request completes; hidden pages pause
and refresh on return. **Muat ulang** requests a refresh manually. The backend
shares successful month reads for 10 seconds per process; this is polling, not
instant push. A failed refresh retains the last reading with a stale-data warning.
Failed reads are not cached as successes. No new environment variables are needed.
Apply `20261007_form_revisions.sql` to requeue previously synced days for the new
number colors. The HTML table reproduces source formatting, not the full editor.

## Tests

```bash
npm test               # validators, allocation inputs, projection and source-table regressions
npm run test:register  # isolated PostgreSQL + 25 concurrent dated allocations
npm run test:authz     # authorization probes; requires running app
npm run test:matrix    # middleware role/status routing; requires running app
```

`npm run test:register` uses installed PostgreSQL binaries (`PG_BIN` may specify their
directory), creates/removes a disposable local cluster, and never consumes live
Supabase numbers. It checks 45/15 reservations, backdating, numeric and alphabetic
suffixes, duplicate-import rollback, role gates, lease takeover and stale versions.

`npm run test:authz` is the one that matters most for security. It mints
correctly-signed JWTs for user IDs that **do not exist in Postgres** and
asserts every protected route still returns 401 — proving the API re-reads the
database instead of trusting the cookie. It also checks the cron secret
comparison, method guards, and input validation.

The old production-counter `test:concurrency` script was removed. Concurrency
verification now exercises the real dated allocator in the isolated database.

## Verification status

### Trailing register cleanup — 14 October

- User approved clearing the entire unused tail, including reserves above the deleted number. The two 6226→6181→5057 examples and frontier reuse passed real disposable PostgreSQL checks, alongside occupied/import/suffix protections, stale/partial/repeated acknowledgements, owner/admin receipt rules, baseline/private-ID invariants, closed-day behavior and preserved 200/45 future-date plans.
- A real concurrent writer-clear/allocation scenario preserved the new occupied slot; existing 25 concurrent allocations and account invariants remained valid. Cron now defers only `REGISTER_TRIM_PENDING` closure errors so calendar clearing can recover automatically; the next invocation resumes normal closure.
- Full actual-module writer regression clears August/September/November using isolated SDK boundaries, preserves a number-free August header/format prototype for later writes, checks B:M-only value clearing and rejects dirty/late native reads. No E1:E0 request or retired-number rewrite is emitted.
- Actual delete-route smoke verified pending202, confirmed trimmed/middle200, missing migration503 before mutation and authorization loss after deletion without false success. Native UI exercised cancel, pending queue, retry, both deletion messages and the surviving 5057 record, including narrow-width feedback.
- Final unit, typecheck, zero-warning lint and isolated PostgreSQL suite passed. Independent SQL/security and writer/API review findings were repaired and re-reviewed; no scoped findings remain. Smoke scaffolds/services were disposable and credential-free.
- Activation: apply only the unapplied `supabase/migrations/20261012_register_tail_trim.sql` after earlier migrations and before deploying the updated deletion/writer code. This forward migration is not a rerunnable seed. Existing pre-migration deletion receipts with unknown original owner are admin-readable only rather than inventing ownership. No production Supabase/Google Sheets modifications were performed.

### Document list layout and sorting — 13 October

- User approved all four audit items in `anti-slop/audit-001-2026-10-13.md` before implementation.
- Unit checks, TypeScript and zero-warning lint passed. Isolated PostgreSQL exercised natural ascending/cross-page descending ordering, numeric/alphabetic and slotless legacy suffixes, date/time ties, null dates, service-only view ACLs and invoker permissions. Existing allocation/deletion/form/settings checks and 25 concurrent allocations remained valid.
- Actual list-route smoke used isolated identities and Supabase transport: all six sort directions, cross-page order, owner/admin/status filters, unauthorized access, private caching and missing-migration503 passed.
- Native actual-component smoke fit 320/390/720/768/1024/1280/1440px without page/table horizontal overflow, showed WIB timestamps, and exercised icon actions, canceled/confirmed deletion, page reset, delayed-response rejection, polling-preserved edits, save, required destination, historical MANUAL, archive readonly and keyboard focus. Green refresh targets measured 44px. Independent UI/security reviews found no remaining scoped defects.
- Apply the unapplied `20261011_document_sort.sql` through SQL Editor after existing register migrations to activate numeric sorting. No production Supabase or Google Sheets writes were performed; runtime smoke used credential-free disposable fixtures. The migration adds only a restricted read-only view and schema reload.

### Fresh aislop concurrency review

- Fixed request ordering in `AuditTab` and `UsersTab`: superseded successes/errors cannot replace current records, pagination, loading or feedback. User creation refreshes the current all-filter correctly; delayed account mutations refresh the latest selected filter. Existing markup, labels and business flows are unchanged.
- `20261010_superadmin_invariant.sql` serializes role/status/deletion statements before row locks and checks departing approved superadmins atomically. It also locks survivors in UUID order so stale Repeatable Read/Serializable snapshots abort safely. Bootstrap inserts and profile-only updates remain valid; bulk removal of every survivor rolls back. The API includes status-only preflight and returns the existing HTTP 409 explanation for `23514 / LAST_SUPERADMIN`, without false success audits.
- Failing-before evidence: actual delayed audit/user responses replaced the current view; two real PostgreSQL transactions both counted two approved superadmins, then removed both. Post-fix native actual-component smoke preserved filtered rows and new accounts; real PostgreSQL tested role loss, status rejection and deletion across Read Committed, Repeatable Read and Serializable. The rollback fixture additionally runs as `service_role`.
- Permanent checks execute actual loader callbacks in `scripts/admin-list-order-test.mjs` and exercise the database invariant through `scripts/register-test.mjs` plus `scripts/users-invariant-test.sql`. Separate UI/security reviews approved the scoped repairs.
- Activation is user-owned: apply only the unapplied forward migration `supabase/migrations/20261010_superadmin_invariant.sql` after the earlier migrations, then deploy the updated code. It installs guards without rewriting users or letter numbers; it does not repair a preexisting zero-superadmin database automatically. No production SQL or original Sheets changes were made.
- Final `aislop@latest` resolved to 0.18.1 and still reports score 67 with 71 reviewed findings. No unreviewed diagnostics were introduced. Retained patterns include valid status/combobox/scroll-region accessibility, asynchronous data effects, SDK/theme compatibility and nullable-count normalization; length and decorative-comment warnings remain policy observations. Fixture passwords, the `PROFILE_PASSWORD` label and trusted local validator evaluation are not deployed secrets or request-driven evaluation. The separate npm audit still reports 13 affected packages; these real dependency advisories are not false positives.
- Final `npm test`, typecheck and zero-warning lint passed. Real isolated PostgreSQL verified all nine mutation/isolation combinations, bootstrap/profile/bulk rules and `service_role` execution; the existing 25 concurrent allocations remained valid. Actual API smoke returned 409 for database invariant conflicts/status-only preflight and emitted no success audits on failure. Native actual-component smoke covered stale responses, rapid filters, delayed PATCH, both creation/all-filter branches and mutation completion after React unmount. No production integration or live activation is claimed.

| Current repair surface | Files |
|---|---|
| UI request ordering | `src/components/AuditTab.tsx`, `src/components/UsersTab.tsx` |
| Atomic user guard | `src/app/api/admin/users/route.ts`, `supabase/migrations/20261010_superadmin_invariant.sql`, `supabase/migrations/20261014_single_superadmin_approvals.sql` |
| Runnable regressions | `scripts/admin-list-order-test.mjs`, `scripts/register-test.mjs`, `scripts/users-invariant-test.sql`, `package.json` |

### Audit actor username

- **Nama pengguna** displays the actor's current username through the existing `audit_logs.user_id` foreign key, not a target username from `details`. Only username is embedded; admin authorization remains unchanged. Left-join semantics retain system/deleted-user records.
- Scheduled cron rows without an actor display **Sistem**; unavailable actors display **Tidak tersedia**. This is a current-account lookup, not a historical username snapshot: renamed accounts show their current name, and deleted accounts cannot be reconstructed. No SQL migration is required.
- **Cari riwayat audit** searches current actor usernames, Sasaran and `details.surat_number` case-insensitively. Search is literal (including punctuation), limited to 100 characters and applied before pagination; Tindakan remains an additional filter. Changing search/filter resets to page 1 and invalidates stale responses.
- No migration or dependency is needed: [PostgREST empty-embed OR filtering](https://docs.postgrest.org/en/stable/references/api/resource_embedding.html#or-filtering-across-embedded-resources) preserves the unfiltered actor username while matching either related usernames or audit fields. Successful responses remain private/no-store.
- Verification used the actual API with disposable PostgreSQL 18/PostgREST 16 and 126 records, covering cross-page counts, uppercase names, action combinations, letter numbers, missing actors, literal reserved characters and admin denial. Native actual-component smoke exercised pagination reset, clear/empty searches, combined filters and the narrow-width search control; loader stale-response regressions passed.
- Unit/type/lint checks passed. Native actual-component smoke verified actor-versus-target attribution, system labeling and unavailable actors using an isolated transport; no production data writes.

### Bounded aislop cleanup

- Fixed the audit filter/page reset race: filtering from page 2 now requests page 1 once, instead of allowing an obsolete page 2 response to overwrite the table. Native actual-component smoke failed before the repair and passed afterward; disclosure controls and combobox keyboard selection remained functional.
- The shared Sheets coordinator now preserves the original writer rejection when lease release also fails, reports release-only failures, and retains the lease after an uncertain remote mutation. `scripts/sheets-sync-test.mjs` exercises error precedence, falsy rejections, release failures and lease safety as part of `npm test`.
- Merged duplicate imports; removed unused legacy audit lookup/status helpers after the version-aware resync cutover; removed a redundant test-header spread fallback and unnecessary regex escaping. Business numbering, ownership, required destination and Sheets projection contracts are unchanged.
- All 79 supplied diagnostics were reviewed. Valid ARIA composites/status/scroll regions, necessary asynchronous effects, nullable SDK/API compatibility fallbacks, cohesive function-size findings and decorative section labels were retained instead of rewriting behavior for a score. Test-only passwords, the `PROFILE_PASSWORD` display label and trusted local validator evaluation are not application secrets or untrusted runtime evaluation.
- `npm test`, typecheck, zero-warning lint, script syntax checks and isolated PostgreSQL allocator/deletion/settings checks passed, including 25 concurrent allocations. Native smoke used an isolated temporary transport; no production database or original workbook writes.
- Dependency audit was completed separately because aislop still reports it skipped. PostCSS resolves to 8.5.30 throughout the tree through the existing dependency plus a same-major npm override; the obsolete Next/PostCSS 8.4.31 installation was removed. `npm ls postcss` is valid. The remaining audit has 7 high and 6 moderate build-chain/Google SDK advisories, not a clean security result. Major Tailwind/SDK migrations were not forced during behavior-preserving cleanup.
- Independent UI and security reviews approved the bounded repairs. No scanner disables or exclusions were added. See the retained findings above before attempting any automatic fix.

| Observed metric | Supplied/before | Final |
|---|---:|---:|
| Aislop 0.18.1 score | 66 | 67 |
| Aislop diagnostics | 79 | 71 |
| Vulnerable packages from separate npm audit | 15 | 13 |

- The final scanner still exits 1 for retained conservative security flags; the separate dependency audit also exits 1 for remaining advisories. Neither is reported as a passing security gate.
- Full actual-app production build passed in an isolated directory with the final dependency tree. The built app rendered login with existing username focus, returned 401 for anonymous audit/document/settings reads and rejected an invalid registration with 400 before database access. No production credentials or project `.next` changes were needed.

| Changed surface | Files |
|---|---|
| UI | `src/components/AuditTab.tsx`, `src/app/(auth)/login/page.tsx` |
| Backend | `src/lib/google-sheets.ts`, `src/lib/audit.ts`, `src/app/api/documents/list/route.ts` |
| Tooling/dependencies | `scripts/authz-test.mjs`, `scripts/check-env.mjs`, `scripts/sheets-sync-test.mjs`, `package.json`, `package-lock.json` |

- Deployment uses the updated lockfile; this cleanup adds no SQL migration. Continue treating dependency advisories separately from heuristic code-quality scores.

### Configurable register settings

- Isolated PostgreSQL `npm run test:register` passed: configurable limits, per-date precedence, deferred allocation, frozen ranges, emergency suffixes, authorization, rollback/recovery of incompatible expired import plans and 25 concurrent allocations. The expired-plan regression failed before the repair.
- `npm test`, typecheck and zero-warning lint passed; final shared-helper/cron changes passed focused typecheck/lint. Actual initialization plus HTTP-handler smoke reproduced HTTP500 before the repair and returned actionable HTTP409 afterward. Independent SQL and admin/UI reviews approved.
- Native smoke exercised the actual sidebar/page/components against an isolated temporary transport: caps, save/edit/delete, and deletion of a past locked plan with editing disabled. No production database or Sheets writes; this was not a production-authenticated end-to-end session.
- Existing deployment: user reported `20261008_required_destination.sql` applied. Apply only `supabase/migrations/20261009_register_settings.sql`, then restart/redeploy. Settings initially retain 15/45; do not rerun older migrations or schema/seed.

### Required destination / CAT removal follow-up

- `npm test`, `npm run typecheck`, `npm run lint` and isolated `npm run test:register` passed. Regression checks failed under the previous optional/CAT-accepting rules, then passed after the cutover; legacy CAT/empty-destination sync and 25 concurrent allocations remained valid.
- Native smoke mounted the actual creation/edit components with an isolated catalog: both inputs are required and both dropdowns exclude CAT. Creation rejected blank/whitespace destinations. No production credentials, Supabase numbers or Sheets writes were used.
- At that follow-up, activation required `supabase/migrations/20261008_required_destination.sql`; the user has since reported it applied. It replaces the shared SQL validator without updating existing rows. Do not rerun older migrations over this validator.


### Demo revisions — 8 October

- Unit/domain/parser checks, isolated PostgreSQL register tests (including 25 concurrent allocations), typecheck and zero-warning lint passed. The final optimized writer production build passed; isolated authorization checks passed 56/56.
- Native browser: Indonesian labels, aligned 64px header rows, blank Satker/Ket initially and after saving, optional destination, explicit MANUAL-only past/future dates, and exact filled/empty number colors. Ten invalid API inputs returned 400 without allocation.
- Approved Sheets copy: blank destination remained empty; successful sync produced E `#FFE599`; deletion produced E `#EA9999` and released the slot. Existing conditional bold/italic/foreground survived filling and cleared when its condition became false. Native register table showed both requested colors.
- Google occasionally exceeded the existing eight-second request timeout. Saves and reuse remained committed and honestly queued/failed, not falsely marked synced. Unchanged layout writes now omit redundant formatting/heights/merge operations; one queued sync and deletion completed successfully.
- No live allocation or original workbook write. October values, entered formats, validation, dimensions, all 90 merges and conditional rules were restored exactly on the copy; `.env.local` hash stayed unchanged. Disposable services/database/app were removed.
- Live activation still requires `supabase/migrations/20261007_form_revisions.sql`; its read-only RPC probe returned `PGRST202`. The deletion migration is already present.


### Cari Surat and safe deletion — 7 October

- Unit/parser checks, TypeScript and zero-warning lint passed; disposable PostgreSQL
  deletion/privacy regressions passed alongside 25 concurrent unique allocations.
- Final isolated production build passed, including type/lint checks. Actual production
  search/queue reads enforced owner filtering for all three roles and returned
  `Cache-Control: private, no-store`; the search page returned200 and removed export404.
- Actual isolated Next/PostgreSQL/PostgREST: **56/56 authorization probes passed**;
  own edit/resync/delete succeeded, foreign user mutations returned404, admin/superadmin
  deletion succeeded, malformed IDs returned400 and undated deletions returned409.
- Real writable-copy Sheets proof: deleted `4991` stayed occupied while another writer
  held the lease; another allocation skipped it. Re-sync cleared contents/checkboxes,
  then another owner reused **4991 on 6 October with new private ID104**, without
  changing the official high-water mark.
- Browser: separate sidebar search for all roles; creation-only forms; own search/status
  filters; read-only legacy rows; cancel/delete; locked async controls; preserved unsaved
  edits; authorization-scope change clears editor; cookie loss clears data and redirects.
  Last-page deletion clamps/refetches; the polling-versus-completion race was reproduced
  failing then proved fixed (25 rows retained). Removed export endpoint returned404.
- Updated isolated migration/RLS diagnostics passed with only the expected localhost
  warning. The test copy was restored to its exact original B:M values, formats,
  checkbox validation, merge ranges, row heights, column widths and grid properties.
- **Live activation is still pending:** apply `20261007_document_delete.sql` in SQL
  Editor. Production numbers, original workbook and `.env.local` were not changed.

### Monthly register — current verification

- `npm test`, `npm run test:register`, typecheck, zero-warning lint and production build passed.
- The real Next.js app ran against local PostgreSQL/PostgREST, with original
  taxonomy/template read from Google using a forced **read-only** OAuth scope.
- Browser: user/admin/superadmin login, code search/keyboard selection, HARI INI,
  month/date alignment, satker creation/duplicate rejection, future/backdated
  allocation, administrator emergency `3418.c`, and edit preserving `5125`/date.
- Failed Google writes left saved letters queued and visible. Admin tables refreshed
  after create/edit without depending on Realtime. Numeric-suffix list search
  was reproduced failing, then verified fixed.
- Authorization smoke: **30/30** checks passed against the isolated runtime.
- Environment/migration/RLS diagnostics passed locally; the only warning was the
  deliberately non-production localhost URL.
- The actual cron rejected premature closing, then closed today at a controlled
  WIB23:59 clock without adding slots to its fixed-45 range.
- The user applied the live Supabase migration; read-only queries confirmed the
  new state and document columns without consuming production numbers.
- Real Google writes passed on the supplied disposable copy using an isolated
  PostgreSQL/PostgREST database: first write, edited contents, lost-ack recovery,
  repeated retries, future and emergency letters, and calendar-only reservations.
- After closing, OKTOBER held **226 distinct numbers** matching the ledger;
  fixed dates stayed at 45 and the dynamic day retained 15 unused slots.
- JULI O:Z values/formats/heights stayed unchanged. Checkbox behavior, date merges
  and template widths passed; a Google-exported PDF visually confirmed the layout.
  The document queue ended at **0 pending / 0 failed**.
- The test copy retains UJI INTEGRASI examples. Original Sheets and `.env.local`
  were not changed. Direct browser-editor interaction and production scheduling
  remain unverified; the print rendering is not an editor screenshot.

### Live spreadsheet view — verification

- New parser regression was observed failing before implementation; the vertical
  merge-tail regression also failed before its correction. `npm test`, typecheck
  and zero-warning lint passed after integration.
- Production build passed in an isolated copy of the current source; the user's
  running development `.next` directory was not replaced or rebuilt.
- Actual approved user/admin/superadmin sessions reached the new page/menu and
  received the complete AGUSTUS register. Anonymous API requests returned 401;
  seven malformed/missing/duplicate month query cases returned 400.
- Updated authorization probes passed **36/36**, including validly signed absent
  user/admin/superadmin/pending sessions on the new route and its POST405 guard.
- Browser verified original values/colors, merged two-row headers, disabled
  checkboxes and matching 21px source row heights. February clamped day31 to28;
  rapid month changes did not overwrite the final selection.
- On the user-supplied disposable copy, filling previously empty **4991** updated
  the website's code/Hal/destination/MANUAL checkbox without page reload. Restoring
  the original 12 cell values also appeared automatically.
- A simulated 503 retained the same table with an explicit stale warning; actual
  cookie removal caused 401, cleared the table and redirected to login.
- This feature verification did not write the original workbook or live database,
  consume numbers, or modify `.env.local`.


### Previous sidebar verification (before the monthly-register change)

Checked against a live Supabase project with `admin`, `user` and `superadmin`
accounts. Every assertion below was read from the rendered DOM or computed
styles, not inferred:

- exactly one `<aside>` and zero `<header>` elements on every authenticated page
- role-specific creation, shared Cari Surat/Register Spreadsheet and guarded
  User Management/Audit Log sidebar entries (current labels documented above)
- identity row order is user icon, then username with role beneath, then button
- the Sign out button computes to `rgb(220, 38, 38)`
- sidebar is 256px wide; the identity row is `position: sticky`
- a **hard refresh** on `/admin/audit` stays on Audit Log, and only that nav item
  gets `aria-current="page"`
- typing `/admin/users` as `admin` redirects to `/admin`; typing any `/admin*`
  URL as `user` redirects to `/dashboard`
- anonymous requests to all five protected routes render **no** sidebar and land
  on `/login`
- the logout API clears the session cookie
- the documents table renders rows with Sync badges and guarded row actions

Still unverified: production/Vercel deployment. Cari Surat uses authorized API
polling, not live Supabase Realtime.
