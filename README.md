# Document Labeling & ID Management System

Atomic, duplicate-proof document numbering with resilient Google Sheets
synchronization and a self-healing retry queue.

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

A document submission runs in this order:

```
1. get_next_document_id()   ->  row lock on id_counter, returns 101
2. INSERT INTO documents    ->  saved as sync_status = 'pending'
3. Google Sheets append     ->  8s timeout
4a. success                 ->  sync_status = 'synced'
4b. failure                 ->  sync_status = 'failed', error logged
```

**The database write happens before the Sheets call and is never rolled back
because of it.** A Google outage costs you a sync, never a document. Failed
rows sit in a queue that the cron job drains every 5 minutes.

The ID counter is incremented inside `get_next_document_id()`:

```sql
SELECT current_val + 1 INTO next_id
FROM public.id_counter WHERE id = 1
FOR UPDATE;
```

`FOR UPDATE` holds a row lock until the transaction commits, so two concurrent
submissions serialize and cannot receive the same number. Note the lock is
released when the RPC commits, which can be *before* the caller's `INSERT`
lands — a crash in that gap burns an ID. That is the right trade-off: IDs stay
unique, they are not gapless.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Create the database

Supabase Dashboard → **SQL Editor** → **New Query**. Run these two files in
order:

1. `supabase/schema.sql` — tables, functions, RLS, Realtime publication
2. `supabase/seed.sql` — the first superadmin (see
   [The first Superadmin](#the-first-superadmin))

### 3. Configure the environment

```bash
cp .env.example .env.local
```

Fill in every value. See [Google Service Account setup](#google-service-account-setup)
for the private key format, which is the one step that reliably breaks people.

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

## Supabase Realtime

Dashboard 2's table updates live. Realtime needs three things, and missing any
one of them fails *silently* — no error, just an empty stream.

**a) Row Level Security enabled** — done in `schema.sql`:

```sql
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
```

**b) Replica identity** — without this, UPDATE events arrive with a `NULL`
primary key and cannot be matched to a row:

```sql
ALTER TABLE public.documents REPLICA IDENTITY FULL;
```

**c) Publication membership** — a table not listed here is not streamed at
all:

```sql
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime ADD TABLE public.documents;
```

### The custom-auth conflict (important)

Realtime authorizes sockets using a **Supabase Auth JWT**. This app does its
own authentication (bcrypt + its own JWT in an httpOnly cookie), so a browser
connecting with the anon key has *no* Supabase session. Under RLS it connects
as `anon`, and without a policy it receives nothing.

That is why `schema.sql` grants exactly this:

```sql
CREATE POLICY documents_anon_select ON public.documents
  FOR SELECT TO anon, authenticated USING (true);
```

**What this means:** anyone holding your anon key can read document titles and
metadata. It is the anon key, which ships to every visitor's browser anyway.
`users`, `audit_logs` and `id_counter` have **no** anon policies at all, and
there is no anon INSERT/UPDATE/DELETE policy on `documents`, so every write
still has to go through a service-role API route.

If your document titles are sensitive, this is the wrong trade. Either sign a
short-lived Supabase-compatible JWT for the socket, or drop Realtime and poll
`/api/documents/list` on an interval.

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
| `user` | `/dashboard` | Create documents, get an atomic ID, view own documents, edit profile |
| `admin` | `/admin` | Everything in `user`, plus: all documents, search/filter, edit metadata and IDs, manual re-sync, CSV export, audit log |
| `superadmin` | `/admin` | Everything in `admin`, plus: approve/reject registrations, create accounts, assign roles |

Registration always creates `role='user'`, `status='pending'` — both hardcoded
server-side, never read from the request body. A pending account is refused at
`/login` and redirected by middleware:

> Your account is pending Superadmin approval.

### Guards against locking yourself out

The superadmin API refuses, with a 409 or 400:

- demoting your own account
- revoking your own access
- deleting your own account
- demoting or deleting the **last** active superadmin

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
| `POST` | `/api/documents/generate` | any approved | Atomic ID + Sheets sync |
| `GET` | `/api/documents/list` | any approved | Paginated, searchable, filterable |
| `GET` | `/api/documents/export` | any approved | CSV (users scoped to own rows) |
| `PATCH` | `/api/documents/update` | admin | Edit title, metadata, or ID |
| `POST` | `/api/documents/resync` | admin | Retry one document, or `{batch:true}` for all |
| `GET` | `/api/documents/resync` | admin | Queue depth for the badge |

### Superadmin / profile / audit / cron

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `GET` | `/api/superadmin/users` | superadmin | List users with counts |
| `POST` | `/api/superadmin/users` | superadmin | Create an account (auto-approved) |
| `PATCH` | `/api/superadmin/users` | superadmin | Approve, reject, change role, delete |
| `PATCH` | `/api/profile/update` | any approved | Change own username / password |
| `GET` | `/api/audit/list` | admin | Paginated audit log |
| `GET` | `/api/cron/resync` | `CRON_SECRET` | Vercel Cron retry pass |

### Search behaviour

`GET /api/documents/list?search=101` matches on `id`. Anything non-numeric
matches `title` with `ILIKE` (case-insensitive). `%` and `_` are escaped so a
literal underscore does not act as a wildcard.

---

## Deployment to Vercel

```bash
vercel
```

Add every variable from `.env.example` in **Settings → Environment Variables**
for all three environments. The `GOOGLE_PRIVATE_KEY` must be pasted in the
single-line `\n` form.

`vercel.json` schedules the cron:

```json
{ "crons": [{ "path": "/api/cron/resync", "schedule": "*/5 * * * *" }] }
```

Vercel sends `Authorization: Bearer <CRON_SECRET>`; the route compares it in
constant time and returns 401 otherwise.

> **Note:** cron schedules on the Hobby plan are limited to once per day. The
> 5-minute schedule requires a Pro plan. Manual re-sync from Dashboard 2 works
> on any plan.

---

## Design decisions and trade-offs

**Custom auth instead of Supabase Auth.** As specified. The cost is that
Realtime cannot authorize the socket (above), so a permissive read policy is
required. The benefit is full control over the approval workflow, which
Supabase Auth does not model.

**The database write precedes the Sheets call.** The reverse order would mean a
Google outage silently discards submissions. Data integrity over synchronous
third-party availability.

**Middleware is a redirect layer, not the security boundary.** The JWT carries
`role` and `status` for 8 hours, so a demotion would not take effect in
middleware alone. Every privileged route re-reads the user from Postgres via
`getFreshSession()`. Middleware also excludes `/api/*` from its matcher — the
auth and cron endpoints have no cookie to check, and running them through the
redirect logic would break sign-in.

**Edits re-append rather than rewrite.** The sheet is an append-only log.
Editing a title appends a fresh row; changing an ID appends an explicit
`ID CORRECTION: 101 -> 205 by admin` row. Rewriting history would require
deleting rows whose positions shift, which is far more fragile than an
append-only audit trail.

**Retries are sequential, not parallel.** Google Sheets has per-spreadsheet
rate limits. `Promise.all` over a batch is the fastest way to collect 429s and
mark healthy documents as failed.

**CSV export neutralizes formula injection.** A title beginning with `=`, `+`,
`-` or `@` is executed by Excel on open. `csvCell()` prefixes those with a
single quote. CSV cells also get a UTF-8 BOM so Excel does not mangle
non-ASCII titles.

**Audit writes never throw.** Losing a log line is strictly better than losing
the document or surfacing a 500 to the user. Failures go to the server log.

**Login responses are uniform.** "No such user" and "wrong password" return the
identical 401 so usernames cannot be enumerated, and the not-found path still
runs a bcrypt compare so response timing does not leak the difference either.

---

## Troubleshooting

**Realtime shows "Offline" in Dashboard 2.** The three requirements in
[Supabase Realtime](#supabase-realtime) are not met, or the browser blocked
the socket. The table still works via Refresh — the badge is informational.

**Every sync fails with a permission error.** The service account cannot see
the spreadsheet. Share it with the `client_email` from your key file and give
it Editor access.

**`Missing environment variable ...`** Copy `.env.example` to `.env.local`.
Restart the dev server after editing env files.

**`invalid_grant` / `Invalid JWT Signature`.** The private key has broken line
breaks. Re-paste it as a single line with literal `\n` and keep the quotes.

**Cron returns 401.** `CRON_SECRET` in the Vercel dashboard does not match the
value the route reads, or the Authorization header was stripped. Vercel Hobby
also only fires crons once per day.

**Can the cron retried a document but the sheet has a duplicate row?** Yes, in
one specific case: the append succeeded but the status update failed, so the
document stayed `pending` and got retried. Retry is idempotent in Postgres but
not in a spreadsheet. Search the sheet for `Document ID` before re-running a
batch if you suspect this happened.

**A document ID was skipped.** Expected and documented above. IDs are unique,
not gapless.

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

## Tests

```bash
npm test               # pure validators + private-key un-escaping. No DB needed.
npm run test:authz     # authorization probes. Needs `npm start` running.
npm run test:matrix    # middleware role/status routing. Needs `npm start`.
npm run test:concurrency   # atomic ID proof. Needs real Supabase. NOT REVERSIBLE.
```

`npm test` covers the username/password validators, the CSV-injection
neutralizer, and the `GOOGLE_PRIVATE_KEY` `\n` un-escaping.

`npm run test:authz` is the one that matters most for security. It mints
correctly-signed JWTs for user IDs that **do not exist in Postgres** and
asserts every protected route still returns 401 — proving the API re-reads the
database instead of trusting the cookie. It also checks the cron secret
comparison, method guards, and input validation.

`npm run test:concurrency` fires N parallel `get_next_document_id()` calls and
asserts every returned ID is unique. It consumes real IDs from your counter and
cannot be undone, so run it on a throwaway project.

## Verification status

`tsc --noEmit` clean, `eslint --max-warnings=0` clean, `next build` clean, and
`npm test` + `npm run test:authz` both 100% green against a running server.

The following are **not** verified, because they need a real Supabase project
and a real Google service account — neither existed in the build environment:

- end-to-end document creation against live Postgres
- the Google Sheets append (header creation, column layout, rate limits)
- Supabase Realtime actually delivering row events (the RLS + publication setup)
- `npm run test:concurrency`

The Realtime claim in particular rests on the SQL being correct, not on
observed behaviour. Verify it by inserting a document and watching the
Dashboard 2 badge flip to "Live".
