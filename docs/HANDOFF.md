# Session Handoff — id-persuratan

**Written:** 2026-10-06
**Reason:** switching CLI (opencode → omp). Everything needed to resume without re-reading the conversation.

---

## 1. What this project is

A **Document Labeling & ID Management System**: users submit document metadata, the app assigns an atomic guaranteed-unique ID, and mirrors each record into a Google Sheet with a self-healing retry queue.

Location: `C:\Magang\id-persuratan`
Branch: `master` · HEAD `1d8dc2c` · 12 commits · working tree clean

**Stack:** Next.js 15.5.27 (App Router, React 19, TypeScript), Tailwind CSS 3, Supabase (PostgreSQL + Realtime), `googleapis` (Service Account), Vercel.

---

## 2. Read this first — the non-obvious decisions

These are the things that will bite you if you don't know they were deliberate.

### 2.1 Registration cannot bootstrap itself (solved)

The original spec was a chicken-and-egg deadlock: registration creates `pending` accounts → pending accounts can't log in → approval happens in a portal that requires an approved superadmin. **Nobody could ever log in on a fresh install.**

Solved with `supabase/seed.sql`, run once by hand:

```bash
npm run hash-password -- "YourPassword123"   # paste output over __HASH_ME__
```

### 2.2 Custom auth and Supabase Realtime are fundamentally incompatible (worked around)

This app does its own auth (bcrypt + its own JWT in an httpOnly cookie). Supabase Realtime authorizes sockets using **Supabase Auth** JWTs. With a custom session the browser connects as `anon`, and under RLS it receives **zero rows — silently, no error**.

Worked around in `supabase/schema.sql`: `documents` gets `SELECT ... USING (true)` for `anon`. Everything else has **no** anon policy, and there is no anon write policy.

> **The cost:** anyone holding the anon key (which ships to every browser) can read document titles and metadata. `users`, `audit_logs`, `id_counter` stay locked. If titles become sensitive, this trade must change.

Three Realtime requirements — all silent on failure:
1. `ALTER TABLE public.documents REPLICA IDENTITY FULL;` (line 175)
2. Table in the `supabase_realtime` publication (line 193)
3. The RLS policy above

### 2.3 Database write precedes the Sheets call, always

`/api/documents/generate` saves to Postgres **first**, then attempts the append. A Google outage costs you a sync, never a document. Failures land in a queue the cron drains every 5 min.

### 2.4 Middleware is a redirect layer, NOT the security boundary

The JWT carries `role`/`status` for 8 hours, so a demotion does **not** take effect in middleware. Every privileged API route re-reads Postgres via `getFreshSession()`.

Middleware's matcher **excludes `/api/*`** — auth and cron endpoints have no cookie yet, and running them through the redirect logic breaks sign-in permanently.

### 2.5 ID gaps are expected; duplicates never are

`get_next_document_id()` takes a row lock (`FOR UPDATE`). The lock releases when the RPC commits, which is *before* the caller's `INSERT` lands — so a crash in that gap burns a number. **IDs are unique, not gapless.** This is correct.

---

## 3. Layout architecture (the most recent work)

Replaced the horizontal topbar with a fixed left sidebar for **all** roles. `AppNav.tsx` was deleted, not trimmed.

```
src/app/(portal)/layout.tsx      ← single session check + single AppShell render
├── dashboard/page.tsx           My Documents
├── profile/page.tsx
└── admin/
    ├── layout.tsx               role gate: admin + superadmin only
    ├── page.tsx                 Documents
    ├── users/page.tsx           superadmin only
    └── audit/page.tsx
src/components/AppShell.tsx      sidebar (left) + identity row (top-right, sticky)
```

Route groups don't appear in URLs — `/dashboard` is still `/dashboard`.

**Nav is per-role:** `user` → My Documents · `admin` → Documents, Audit Log · `superadmin` → Documents, User Management, Audit Log.

**Three independent access layers:** nav filtering (UI) → route layout (server) → `requireAdmin()`/`requireSuperadmin()` (API).

### Bug this work fixed

Tabs read `?tab=` once at mount, so refreshing on Audit Log silently fell back to Documents. Sections are now real routes with state derived from `usePathname`.

---

## 4. Environment & how to run

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run check:env              # ← run this; validates everything below
npm run dev
```

`npm run check:env` is the important one. It reports missing/invalid vars, malformed JWTs, a service-role key with the wrong `role`, a private key that won't un-escape, missing tables, an unseeded superadmin, and **RLS leak checks**.

### Current state: configured and working

- Supabase: `https://ictxyyunmzejfmdquwyx.supabase.co`
- `.env.local` gitignored, **never committed** (verified: `git log --all --full-history -- .env.local` is empty)
- Accounts exist: `superadmin`, `admin`, `user`, `user2`
- `CRON_SECRET` was regenerated (now 64 chars, distinct from `SESSION_SECRET`)

### Two env gotchas that already bit us

1. **`NEXT_PUBLIC_SUPABASE_URL` must NOT end in `/rest/v1/`.** The SDK appends its own paths → `/rest/v1/rest/v1/...` → every query 404s. Bare project URL only.
2. **`GOOGLE_PRIVATE_KEY` must be one line with literal `\n`** and wrapped in double quotes. Never real newlines — the Vercel UI mangles them. `google-sheets.ts` does `.replace(/\\n/g, '\n')` at runtime.

---

## 5. Verification status — be honest about this

### Passing

- `npm run typecheck` — exit 0
- `npm run lint` (`--max-warnings=0`) — exit 0
- `npm run build` — compiled, 21 routes
- `npm test` — 17/17 (validators, CSV injection, key un-escaping)
- `npm run test:authz` — 27/27 (ghost-token rejection, cron secret, method guards)
- Browser pass against live Supabase: sidebar, per-role nav, identity-row order, `rgb(220, 38, 38)`, 256px, sticky row, hard-refresh route persistence, role redirects, anonymous users seeing no shell, live document rows

### NOT verified — do not assume these work

| Item | Why | How to check |
|---|---|---|
| **Supabase Realtime** | Badge read "Offline" in testing. Could be genuine publication failure or sandbox network flake. | Create a document on `/dashboard`, watch it appear on `/admin` without refreshing. |
| **Google Sheets append under real load** | Never hit a rate limit. | Check for duplicate rows after a cron retry. |
| **`npm run test:concurrency`** | Needs a throwaway project | See below |
| Production/Vercel deploy | Never attempted | `vercel` |

**The no-duplicate-ID claim is unproven by anything but SQL reading.** Run this on a throwaway project:

```bash
npm run test:concurrency    # 25 parallel RPC calls, asserts uniqueness
```

**It consumes real IDs irreversibly.** That is why it was never run against production.

---

## 6. Open items

### 6.1 Demotion redirect loop — pre-existing, fail-closed, needs a ticket

If a user's role is demoted admin→user while their unexpired JWT still claims `admin`:

```
/dashboard → middleware.ts:126 → /admin → admin/layout.tsx:19 → /dashboard  (forever)
```

**The fix is one word.** In `src/app/(portal)/admin/layout.tsx:19`, redirect to `/profile` instead of `/dashboard`:

```ts
if (user.role !== 'admin' && user.role !== 'superadmin') redirect('/profile');
```

`/profile` is not gated by the middleware rule that causes the bounce, so this breaks the cycle. Left unfixed as a permissions decision, not a layout one.

### 6.2 Possible duplicate Sheets writes

`Sheet1` shows IDs 103/104/105 with **2 sync attempts**, and 104 has **no sync timestamp**. Retry is idempotent in Postgres but **not** in a spreadsheet — if the append succeeded and the status write failed, the row is retried and duplicated. Search the sheet by Document ID before re-running a batch if you suspect this.

### 6.3 Accepted, ship-as-is minors

- `NAV_ITEMS` active-match special-cases `/admin` and `/dashboard` outside the data array (`AppShell.tsx`). Correct today, footgun if a second index route is added.
- Dashboard widened from `max-w-5xl` to `max-w-7xl` (AppShell applies one width everywhere). Visual change, not a defect.
- `ShellUser` exported but imported nowhere.
- Profile link has both `title` and `aria-label` — intentional, `title` is the sighted tooltip.

---

## 7. Google Sheet currently in `.env`

`tes_id_persuratan` — `1h5orPQaSU_ctgMV9EHvm578m8M-wn5oGixlo9cMZLnM` (4 tabs)

| Tab | Content |
|---|---|
| `Sheet1` | The app's sync target. Header + 5 rows. |
| `Acuan No Surat` | **Buku Pintar Permendagri 83/2022** — national archive classification taxonomy. 1,093 rows, 993 codes, 4 levels, 10 top-level groups. |
| `JULI` | Monthly letter register, 666 rows |
| `AGUSTUS` | Monthly letter register, 657 rows |

Month-tab columns: `NO | KD SURAT | / | NOMOR SURAT | / | KD SATKER | HAL | [remark] | CAT | SRIKANDI | EOFFICE | MANUAL`

**Key finding — numbering is one unbroken sequence across both months:**

```
JULI     3338 → 3914   577 numbers, zero gaps
AGUSTUS  3915 → 4464   550 numbers, zero gaps   ← starts exactly at 3915
```

That is the same invariant `get_next_document_id()` enforces, held by hand. **All 51 codes used in the month tabs resolve against the taxonomy — zero orphans.**

**Backlog:** 54 letters flagged `belum pertinggal` (JULI 20 / 3.2%, AGUSTUS 34 / 5.8%), concentrated on named people — Susi 34, Ka Leo 9, Putri 3, Melisa 3, Anggie 2. An open work queue, not a data error.

**Relevance:** the app's global counter starts at 101; this register is at 4,464 and counting. If both ever run together they would collide. The register's fields (`KD SURAT`, `HAL`, satker, routing booleans) map cleanly onto the existing `metadata` JSONB — no schema change needed.

---

## 8. Key file map

| Path | Role |
|---|---|
| `supabase/schema.sql` | Tables, `get_next_document_id()`, RLS, Realtime publication. Run once. |
| `supabase/seed.sql` | Plants the first superadmin. Run once. Contains `__HASH_ME__` placeholder. |
| `src/lib/auth.ts` | bcrypt, JWT session, `requireUser/Admin/Superadmin`. `import 'server-only'`. |
| `src/lib/google-sheets.ts` | Service-account client, 8s timeout, header auto-create. |
| `src/lib/resync.ts` | Shared retry engine — manual button and cron both use it. |
| `src/lib/audit.ts` | `writeAudit` (never throws), `AuditAction` enum. |
| `src/lib/supabase.ts` | Server client, service role. **`supabase-client.ts` is the browser one (anon).** |
| `src/middleware.ts` | Edge. Page routes only, excludes `/api/*`. |
| `src/components/AppShell.tsx` | Sidebar + identity row. |
| `scripts/*.mjs` | `check:env`, `test`, `test:authz`, `test:matrix`, `test:concurrency`, `hash-password` |

**First-run gotcha:** when applying `schema.sql`, Supabase's linter warns "creates a table without enabling RLS." **Choose "Run and enable RLS."** It is a false positive — RLS is enabled ~130 lines later at section 7, but the linter judges each statement in isolation.

---

## 9. Gotchas that will waste time if unknown

- **Transient DNS failures on this machine.** Both the shell and the dev server hit `TypeError: fetch failed` mid-session and recovered on retry. Not a code bug — retry before debugging.
- **PowerShell treats `()` as special.** Always quote: `git mv src/app/admin "src/app/(portal)/admin"`.
- **No configured git user.** Commit with `-c user.name="OpenCode" -c user.email="opencode@local"`.
- **ESLint 9 flat config** (`eslint.config.mjs`), not `.eslintrc`.
- **Deleting a component while `next dev` is running** leaves webpack caching its path → 500s. `rm -rf .next/cache` and restart.
- **`git add -A` in PowerShell needs explicit paths** for parenthesised dirs.
- Browser automation: `fetch` returns 200 for Next.js client-side redirects. Assert on rendered DOM (`document.querySelectorAll('aside').length`), never on status alone.
- **React hydration timing** — polling DOM too early reports empty tables. Poll until the predicate holds.

---

## 10. If you only remember five things

1. Realtime is **unverified**. Check it before trusting Dashboard 2's live updates.
2. The no-duplicate-ID guarantee is **unproven by test**. `npm run test:concurrency` on a throwaway project.
3. `.env.local` holds a live service-role key that bypasses RLS. Never commit it.
4. `npm run check:env` first — it catches almost every setup mistake as a readable message.
5. The demotion redirect loop fix is one word in `admin/layout.tsx:19`. Deferred deliberately.
