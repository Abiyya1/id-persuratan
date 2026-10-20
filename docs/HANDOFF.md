# Session Handoff — id-persuratan

**Updated:** 2026-10-08 · repository: `C:\Magang\id-persuratan`

## 1. Current state

The generic entry/Sheet1 append flow has been replaced by the requested **2026 monthly letter register**. The user applied the production migration; read-only API checks confirmed the new state/columns. Real Google writes, edits, retries, reservations and printed layout have now passed on the user-supplied disposable workbook with an isolated database. Production numbering was not initialized or consumed by those tests.

**Cari Surat** now lives at `/documents`, separate from creation. CSV export is removed. All approved roles share search/edit/re-sync/delete; ordinary users are restricted to their own letters, admin/superadmin to all application letters. Deletion clears contents but holds the original-date number until Sheets acknowledges the current cleared day revision. Undated legacy rows remain read-only.

Stack unchanged: Next.js 15.5.27, React 19, TypeScript, Tailwind, Supabase PostgreSQL and existing `googleapis`. No browser Realtime/client; authorized API polling replaces it. No new application dependencies. No commit made; do not assume the working tree is clean.

`.env.local` was not changed. Tests did not allocate live Supabase numbers or write the original Google workbook.

Demo revisions: Indonesian interface/messages and **Buat Nomor Surat**; KD Satker
and Ket start/reset blank; destination is now required for creation/content edits;
today Ket allows SRIKANDI/EOFFICE/MANUAL, other dates require explicitly selected MANUAL. Numbered E cells
are yellow `#FFE599` when occupied and red `#EA9999` when empty, web and Sheets.

## 2. Activation prerequisites

1. **Existing Supabase project:** `supabase/migrations/20261006_letter_register.sql` was applied by the user and confirmed through read-only queries (`year=2026`, register uninitialized at the check, new document columns present). Do not rerun the fresh-install schema/seed against this project.
2. **Deletion activation confirmed:** 8 October read-only live REST check successfully selected `letter_slots.release_pending,release_requested_by`.
3. **Latest guard activation pending:** apply the unapplied `supabase/migrations/20261010_superadmin_invariant.sql` after any unapplied earlier migrations, then restart/redeploy. It prevents concurrent removal of every approved superadmin without rewriting user/letter data. The assistant authored and tested it only in disposable PostgreSQL; no production application is confirmed. Do not rerun old migrations, schema or seed.
4. **Fresh install:** schema → `20261006_letter_register.sql` → `20261007_document_delete.sql` → `20261007_form_revisions.sql` → `20261008_required_destination.sql` → `20261009_register_settings.sql` → `20261010_superadmin_invariant.sql` → seed. Replace the seed password hash first using `npm run hash-password -- "YourPassword123"`.
5. **Verified Sheets target:** the user supplied `1If1iXh3WM0BdkJYtiQNGA9tzR9N-BWu0xZJhbyPCPHc`, shared with the service account. It contains earlier UJI INTEGRASI rows; keep it separate from production. Deletion checks use a disposable database and this copy only. `.env.local` still points to the original workbook and was not edited.
6. Configure the two authenticated schedules from `vercel.json`: retries every five minutes and closing at UTC16:59 / **23:59 WIB**. Vercel Hobby does not support the required five-minute schedule; use a suitable plan or external authenticated scheduler.
7. Drive sharing is owner-managed, not controlled by app roles. Only authorized admin/superadmin Google accounts and the service account should access the workbook; remove ordinary users/public sharing. Numbers must still be allocated in the application, not manually in Sheets.

Required environment variables and key formatting are listed in README. This checkout has no `.env.example`. Keep Supabase URL bare (no `/rest/v1` suffix), keep `GOOGLE_PRIVATE_KEY` quoted with literal `\n`, and keep secrets out of version control. `GOOGLE_SHEET_NAME` is obsolete: month tabs are selected automatically.

## 3. Approved business rules

- Form: searchable KD Surat, server-assigned Nomor Surat, KD Satker, Hal, required Tujuan Surat, Ket, month/date and HARI INI. Destination must be a trimmed nonempty string of at most 500 characters; omitted/null/whitespace/non-string/over-500 input is rejected.
- New forms and successful submissions leave KD Satker/Ket blank and required. Date changes clear Ket. Imported source satker values remain intact; newly reserved empty rows have no Pusdatin fallback. Administrators can add catalog entries.
- Date is an actual 2026 civil date in Asia/Jakarta; month must match. Today permits SRIKANDI/EOFFICE/MANUAL; any other date permits only explicitly selected MANUAL. CAT is unavailable on creation/content edits; existing CAT/empty-destination archives remain readable and synchronization-only updates are allowed. Imported CAT spreadsheet columns remain intact. Number/date remain immutable.
- Backdating consumes the **first unused numbered slot on that date**, not a new global number.
- Future submission reserves the configured ordinary total for each intervening unfixed day; already-used ordinary slots count. Initial default45, range1–150. The target day remains dynamic without a custom plan until a later range exists.
- Close at **23:59 WIB** with the configured minimum unused numbers on open days without a custom plan. Initial default15, range1–50. Fixed days receive no more slots; missed calendar days catch up.
- Admin/superadmin sidebar **Pengaturan Nomor Surat** (`/admin/register-settings`): plan1–400 ordinary numbers per today/future2026 date, overriding both defaults when processed. Saving never allocates. Cannot shrink or modify fixed/closed ranges; imported final date remains expandable without a later range.
- Removing any date plan, including a past/locked plan, only deletes configuration. Incompatible pre-import plans stop initialization atomically with HTTP409; remove the conflicting plan and retry. Emergency suffixes do not count toward a custom ordinary total.
- Once a later range exists, an earlier range cannot expand. `DAY_FULL` enables explicit admin/superadmin emergency confirmation and a 1–500-character reason. Allocate the day's last base number plus `.a`, `.b`, … `.z`, `.aa`, …; audit only genuinely newly allocated emergency suffixes.
- Existing numeric suffixes (`3939.1`, etc.) remain intact. Consuming an already-unused imported suffix is ordinary allocation, not an emergency audit event.
- No historical range/base number means `DAY_MISSING`, not an invented number.
- Only **2026** is supported now. The next year's deployment needs a new workbook and must retain the register's high-water mark; never reset official numbering by month/year.

The live workbook has `Sheet1`, `Acuan No Surat`, JULI and AGUSTUS. JULI/AGUSTUS are the source register; Sheet1's old generic app records are not migrated into invented dated letters. Taxonomy inspection found **993 classification codes**.

Actual register columns **B:M**:

| Column | Field |
|---|---|
| B | NO |
| C | KD SURAT |
| D | `/` |
| E | NOMOR SURAT |
| F | `/` |
| G | KD SATKER |
| H | HAL |
| I | TUJUAN SURAT |
| J–M | CAT / SRIKANDI / EOFFICE / MANUAL |

AGUSTUS places the date heading in **C:E**, followed by two header rows. Projection copies that actual geometry, widths, formats and checkbox behavior. JULI's separate **O:Z** register is protected: no inserted/deleted rows, no B:M boundary-crossing merges, and existing JULI row heights are preserved. Legacy text annotations in J:M are preserved; annotation-only rows count as occupied and cannot be reassigned.

Existing base numbers end at **4464 on 31 August**. Bootstrap closes missing dates after the last imported day: 1 September–5 October contributes 35 × 15 reserved numbers. Thus the first ordinary 6 October number was **4990**, not 4465. This is intentional, not a skipped-ID defect.

## 4. Storage, synchronization and APIs

- `documents.id`: retained private numeric row key. `surat_number`: unique official text number. `letter_date`: date or null for legacy records. `title`: Hal. Metadata: `{kdSurat, kdSatker, tujuanSurat, ket}`.
- `register_state`, `register_days`, `letter_slots`: authoritative dated ledger. Original cells are retained in slot JSON; imported occupied records are not fabricated app submissions/users.
- `create_registered_document` reserves, allocates and inserts the document in **one advisory-locked SQL transaction**. Approval/role is rechecked in SQL. Google failure cannot undo that transaction.
- `get_register_month` returns days, slots and documents from one SQL snapshot, avoiding inconsistent paginated reads during concurrent allocation/editing.
- `syncDocumentRow(doc)`/`syncRegisterCalendar()` write monthly B:M contents/geometry, then native-text-preserving E fills in two bounded atomic Google batches under one lease. Acknowledge only after both. Unchanged physical rows retain formats/validation/heights/merges; only new/moved rows send formatting.
- Global PostgreSQL writer lease: **240 seconds**, renewed before a mutation, retained after an uncertain failure. This exceeds Google's [180-second request processing limit](https://developers.google.com/workspace/sheets/api/limits), unlike the original 120-second draft. HTTP calls have an actual 8-second timeout and automatic retries disabled.
- Acknowledgement checks day revision and document `updated_at`; stale writers cannot mark newer contents synced. Busy/failed writes remain pending/failed for retry. Already-acknowledged months are not rewritten for every queued document.
- Legacy undated application records stay readable; editing/resync/deletion returns a clear read-only error. No guessed classification/date and no Sheet1 writes.
- Both pending and failed dated documents are retryable. Cron closes calendar days **before** checking Google availability and returns an observable failure when projection/retries fail.
- The daily query `closeDay=1` takes effect only at WIB23:59, so an authenticated early request cannot prematurely close today. A delayed request uses normal elapsed-day catch-up.
- `delete_registered_document` locks the allocator/actor/document/day/slot, deletes the private document, blanks fields and four checkboxes, unlinks ownership and creates a minimal transactional `DELETE_DOC` audit. The slot stays occupied with `release_pending=true`; counters and suffix identity do not change.
- Only the current writer lease plus matching day revision can release a held slot. A stale acknowledgement cannot free it. The next allocation on the original date reuses the number with a new private ID and owner/metadata. Batch retry and cron project pending deletions even if no documents remain.

New/changed endpoints:

| Endpoint | Contract |
|---|---|
| `GET /api/documents/options` | Approved users; classifications, satkers, server WIB date and year |
| `GET /api/register/sheet?month=1..12` | Fresh-approved users of every role; complete actual Sheets B:M, read-only, private/no-store |
| `POST /api/satkers` | Admin/superadmin; `{name}` |
| `POST /api/documents/generate` | `{kdSurat,kdSatker,hal,tujuanSurat,ket,date,month,emergency?,emergencyReason?}` |
| `GET/PUT/POST/DELETE /api/register/settings` | Fresh-approved admin/superadmin; GET current DTO, PUT `{closingUnusedMinimum,futureDailyTotal}`, POST `{date,total}`, DELETE `{date}`. Private/no-store; mutation RPCs recheck actor and serialize with allocator/closing. |
| `PATCH /api/documents/update` | Fresh-approved owner (admin all); private `id`, title and metadata; number/date immutable |
| `DELETE /api/documents/delete` | Fresh-approved owner (admin all); `{id}`; 202 while held, 200 after confirmed release; legacy409 |
| `GET /api/documents/list` | Own rows (admin all); exact official base/alphabetic/numeric-suffix search; other text matches Hal |
| `GET/POST /api/documents/resync` | Own single/batch retry and failed/pending/deleting counts (admin all) |
| Cron | Global idempotent calendar/deletion projection and version-aware document retry |

Ordinary callers cannot forge `createdBy` to list, update, resync, delete or inspect another owner's queue. All ledger tables/RPCs remain service-role-only. DocumentPortal is form-only; DocumentSearch owns guarded 15-second visible polling. Unsaved edits survive same-scope polling; changed role/owner scope clears the editor/rows. Query controls lock during editing/async actions. CSV endpoint/callers and the unused browser client are removed.

The user explicitly approved **all approved roles reading the full spreadsheet
register**, including imported records and others' letters, through the separate
`/register-sheet` page/sidebar entry. This is a new read-only access grant, not a
change to ordinary document list/mutation ownership scopes. The server reads Sheets
directly with existing credentials; this view needs no Apps Script/publication/env.
Native month/day selectors filter the source table. Source formatted values,
Boolean checkboxes versus text annotations, effective colors/theme/fonts/borders,
merges and dimensions are preserved. Text is clipped to source heights (full text
on hover), and O:Z is outside the view. This is an HTML register, not the Sheets editor.

The read helper has a per-process 10-second successful-result single-flight cache.
Errors evict their matching entry; absent months require metadata confirmation.
The client requests another reading 10 seconds after completion while visible,
refreshes on visibility/focus, cancels obsolete month loads and clears data on
401/403. Source failures show a stale warning with the last same-month reading;
no success timestamp or empty register is fabricated.


## 5. Observed verification

### Fresh aislop concurrency review

- Current fixes cover stale audit/user responses and mutation refresh closures, plus an atomic database invariant retaining an approved superadmin. UI markup/business flows are unchanged. See README **Fresh aislop concurrency review** for the detailed concurrency and activation contract.
- Actual components and real PostgreSQL reproduced failures before repair. Native stale-response, rapid-filter, delayed-PATCH and creation/all-filter branches passed after repair. The isolated SQL runner passed nine role/status/deletion-by-isolation combinations and the rollback `service_role` fixture; the existing 25-allocation and deletion/settings guards remained valid.
- `admin-list-order-test.mjs` executes actual loader logic to protect record/pagination/error/loading publication. The new migration is authored only, not confirmed live; activate it before relying on concurrent last-superadmin protection.

### Bounded aislop cleanup

- Preserved business behavior while fixing audit filter/page reset ordering and shared Sheets writer/release error precedence. Both had failing-before runtime evidence; the actual audit component passed afterward and the permanent Sheets coordinator regression runs in `npm test`.
- Removed unused legacy `getDocument`/`recordSyncResult` audit helpers; active resync remains owner-scoped and version-aware. Duplicate imports and two mechanical script findings were cleaned up.
- Unit/type/lint/syntax checks and isolated PostgreSQL tests passed, including 25 concurrent allocations. Native custom combobox keyboard selection and audit disclosure controls remained functional. No production numbers, original Sheets or project environment changes.
- See README **Bounded aislop cleanup** for retained scanner findings and dependency-audit decisions; review diagnostics rather than deleting valid accessibility or security-boundary behavior to increase a score.
- Final same-major PostCSS override is effective: all installed resolutions use 8.5.30, stale nested Next/PostCSS is removed, and npm reports a valid tree. The remaining dependency audit is not clean; counts, retained scanner flags and upgrade boundaries are recorded in README.
- Full actual-app isolated production build and login/anonymous API/invalid-registration runtime smoke passed with dummy backend configuration. Independent UI and security reviews approved. No additional SQL migration is required for this cleanup.

### Configurable register settings

- Isolated PostgreSQL settings fixture covers caps, role/approval checks, no allocation on save, precedence, fixed ranges, suffix preservation and atomic expired-import conflict/recovery; full `npm run test:register` passed including 25 concurrent allocations. Expired-plan regression failed before the SQL repair.
- `npm test`, typecheck and zero-warning lint passed. Final initialization/cron changes passed focused typecheck/lint; actual shared-helper/HTTP-handler smoke returned HTTP500 before the repair and HTTP409 afterward. Independent SQL and admin/UI reviews approved.
- Native actual-component smoke with an isolated temporary transport verified caps50/150/400, default saves, custom save/edit/delete, past locked edit disabled and config-only deletion available. Not production-authenticated or a live Sheets integration.
- Next action: apply only `20261009_register_settings.sql` and restart/redeploy. Initial settings15/45 preserve existing behavior; no original workbook or production number changes were made.

### Required destination / CAT removal follow-up

- Focused regressions failed first for empty destination, then CAT. Isolated PostgreSQL failed under the old validator and passed with `20261008_required_destination.sql`; legacy CAT/empty-destination sync-only updates and 25 concurrent allocations stayed valid.
- `npm test`, typecheck and zero-warning lint passed. Independent form/API and SQL reviews approved with no concrete findings.
- Native actual-component smoke used a temporary catalog boundary without production credentials: create/edit inputs required, both dropdowns exclude CAT, creation blank/whitespace rejection observed. Temporary harness is not an end-to-end production session or a Sheets integration check.
- At that follow-up, activation required `supabase/migrations/20261008_required_destination.sql`; the user has since reported it applied. Preserve old rows and previously applied migrations.


### Demo revisions — 8 October

- Domain/parser/unit tests, isolated PostgreSQL/WIB-boundary tests and 25-way allocation checks passed. Typecheck/lint passed; final production build passed; isolated authorization checks were 56/56.
- Native UI verified `lang=id`, Indonesian labels, header bottoms at exactly 64px, empty Satker/Ket defaults/reset, optional destination, only explicitly selected MANUAL on past/future dates, and yellow/red register cells. Ten invalid API requests returned 400 without allocating.
- Real copy sync: optional destination I stayed empty; occupied E was `#FFE599`; cleared E was `#EA9999` and the dated slot released. Existing conditional bold/italic/blue foreground survived the fill and became false again after clearing.
- Reuse returned a new private ID for the same dated number and blank destination. Intermittent Google eight-second timeouts correctly retained failed/queued sync; do not describe every attempt as successful. Unchanged-layout writer payloads now omit redundant formats/heights/merge operations; a subsequent queued sync and deletion both completed.
- Copy October snapshot restored exactly: 253 rows, entered B:M values/formats/validation, row/column sizes, 90 merges, zero original conditional rules. Original `.env.local` hash unchanged, original workbook untouched, no live number allocations. Disposable app/database/services removed.
- Apply `20261007_form_revisions.sql` to live Supabase before activation; the validation RPC was absent (`PGRST202`). Deletion columns were already available.


### Cari Surat / deletion — 7 October

- Final units/parsers, typecheck and zero-warning lint passed. Actual isolated PostgreSQL deletion/ownership/legacy/held-release/numeric-alpha-reuse/privacy checks passed; 25 concurrent allocations remained unique. Old public read policy was observed failing the new privacy regression before removal.
- Final current-source production build passed with integrated type/lint checks; actual production requests proved user-owned filtering, authorized admin/superadmin owner filtering, search200/export404 and `private, no-store` on list/queue reads for all roles. Original development `.next` was not rebuilt or replaced.
- Actual isolated Next/PG/PostgREST auth smoke **56/56 passed**. Approved-owner edits and retry worked; ordinary foreign edit/resync/delete404 before mutation, admin/superadmin foreign deletion200, five malformed ID cases400 and all-role undated deletion409.
- Real Google-copy deletion: own **4991 / ID101** disappeared from SQL while its slot stayed held and the old Sheets text remained during a different writer's lease. Another actor's creation skipped the held number and received4993. Own queue showed deleting1; another owner's queue did not.
- Native Re-sync all repaired the empty own-document deletion queue. Actual B:M classification/satker/Hal/destination/four checkbox fields cleared before slot release. Another user then reused **4991 on 6 October / new ID104** with fresh owner/metadata; official high-water mark stayed unchanged. Admin/superadmin cleared other-owned records.
- Native UI for all three roles: independent Cari Surat/sidebar, no CSV controls, creation-only forms, read-only legacy actions. User search/status filters stayed own-scoped. Unsaved input survived polling; fresh scope demotion discarded foreign editor/data; missing cookie redirected to login with no table/sidebar.
- Deleting the sole last-page item clamps2→1 and reloads25rows. Review uncovered polling-clamp-before-action-completion: actual browser reproduced25→0 before correction, then retained25 after using the latest refresh callback. Both code reviews completed with no remaining actionable findings.
- Own batch retry synced25 owned outcomes, returned `{failed:0,pending:0,deleting:0}`, and did not return foreign document103. Actual audit filter displayed all six transactional `DELETE_DOC` events. Deleted export route404.
- Updated isolated diagnostics passed (only localhost URL warning); anon read returned zero documents despite populated data and anon writes were denied.
- Test app/browser stopped before restoring the approved copy. Original OKTOBER B:M values, formats, checkbox validation,90 merge ranges,253 row heights,12 column widths and sheet properties now match the pre-test snapshot (merge response array order normalized). Production workbook/DB numbering/env were untouched.

- `npm test`: existing 17 validator/key checks plus structured-field, date-heading, taxonomy/suffix/projection checks passed. Regressions cover blank checkboxes, retained text annotations and annotation-only occupancy.
- `npm run test:register`: an isolated PostgreSQL 18 cluster exercised the real migration/allocator, 45/15 rules, earliest backdate, duplicate-import rollback, pending/emergency role denial, `.a/.b/.aa`, numeric legacy suffixes, stale status protection, lease expiry/takeover and revision-aware acknowledgement. **25 simultaneous database connections received 25 unique official numbers.** Only the disposable cluster's SQL clock is fixed to 6 October 2026 so the permanent checks remain deterministic; production has no test clock override.
- `npm run typecheck`, zero-warning lint, and **`npm run build` passed** (Next.js 15.5.27).
- Authorization script: **30/30 passed** against the real isolated Next/PostgreSQL/PostgREST runtime. The removed `test:concurrency` script is obsolete; it used to consume live private counter IDs.
- Earlier register diagnostics passed with isolated REST tokens and escaped-PEM encoding. The then-existing public Realtime read policy is now removed by the deletion migration; the new SQL privacy regression detects that old policy.
- Real browser: user/admin/superadmin login; taxonomy code/description search and keyboard selection; date/month controls and HARI INI; admin/superadmin satker creation; ordinary-user denial; invalid date rejection; case-insensitive duplicate satker rejection; immutable number rejection; future reservation and backdated emergency allocation.
- Actual local examples: `4990` for 6 October; administrator emergency **`3418.c`** on an exhausted historical day (original `.a/.b` already existed); future 9 October **`5125`** with preceding 45-slot dates. An edit preserved `5125` and 9 October and refreshed the table. Number/date inputs were read-only.
- A real numeric-suffix record was initially absent from list search, then returned after using the shared official-number parser.
- Google mutation failures were authentic: runtime forced the original service-account OAuth scope to **read-only**, so the original workbook was never modified. Saved letters remained queued with visible sync warnings.
- Cron at actual WIB15:57 rejected early closing. With a throwaway controlled WIB23:59 clock, the actual Next endpoint closed 6 October while its fixed ordinary-slot count remained **45**. Google failure stayed observable. Temporary clock/runtime artifacts are not part of the application.

### Supplied writable workbook — verified

- Ran the actual compiled `google-sheets.ts`/`resync.ts` against real local PostgreSQL 18/PostgREST 16.4 and the supplied Google copy, with mutation guards rejecting any other workbook ID. Production received only read-only schema checks.
- Successful first write: **4990**. Simulated lost acknowledgement after that real write, reset the isolated queue/revision acknowledgement, then recovered through the actual retry engine without a duplicate row.
- Edited Hal and Ket on the same **4990** row; official number/date remained unchanged. Two further resync calls also left exactly one row.
- Future **5125**, emergency **3418.c**, and 45-slot preceding ranges were written successfully. Calendar-only SEPTEMBER contained **450** reserved slots.
- Closing 9 October left **15 unused slots** (16 total including its used letter), while the three fixed dates stayed at 45. Google OKTOBER contained **226 distinct official numbers**, exactly matching the isolated ledger after closing.
- Full JULI O:Z value/format/validation/row-height/width snapshot hashes matched before and after the real JULI mutation.
- Date merge C:E, checkbox validation/checked MANUAL value and all 12 column widths matched the AGUSTUS template. Google exported the actual updated row to PDF; its rendered image visually confirmed date heading, two-row header, slashes, satker, Hal/destination and checkbox layout. Browser editor opening timed out, so visual proof is the actual Google print rendering, not an editor screenshot.
- Persisted document queue finished with **0 pending / 0 failed**. Test issues were confined to the temporary harness (missing bare-PostgreSQL default grants, and an expectation initially omitting 75 bootstrap calendar slots); no application code changes were required.

### Website spreadsheet view — verified

- `npm test` now includes `scripts/sheet-register-test.mjs`: actual heading/date association (including a date mentioned in Hal), numeric/alphabetic prefixes/suffixes, Boolean versus legacy text, effective theme color, nonzero grid offsets, header/vertical merges, O:Z exclusion and merged blank tails. Observed missing-feature RED, then merge-tail RED before corrections; integrated tests/typecheck/zero-warning lint passed.
- Live read-only approved sessions for user/admin/superadmin returned HTTP200, 23 actual AGUSTUS days, 12 columns, original `.3915` and its effective `#ffe599`; every role's browser had the active Register Spreadsheet sidebar entry. Anonymous API401 and seven invalid-month400 probes passed.
- Actual browser rendering initially reproduced oversized row heights from inherited line-height/content growth. Corrected normal line-height and bounded cell content; every displayed 4 August source row matched **21px**. Checkboxes were disabled; source content, colors, merges and widths were visible.
- Isolated Next runtime used the supplied copy only, with its own source/build directory and process-only Sheets ID override. Filling unused copy **4991** with code/Hal/destination/MANUAL true automatically appeared without navigation/reload. Restored the original entire 12-value row exactly; its restoration also refreshed automatically. No live database mutation or number allocation.
- Actual browser: day31→February28, rapid July→August selection remained on 4 August, missing JANUARI returned available:false only after metadata confirmation, simulated503 retained identical table with stale warning, actual cookie removal caused401 and cleared/redirected the view.
- No application dependency, migration or `.env.local` change. Original workbook and user-owned running development server were not changed by test writes.
- Production build passed against an isolated copy of the current source (including dynamic `/register-sheet` and `/api/register/sheet`). The user's original development `.next` was not rebuilt or replaced.
- Updated `scripts/authz-test.mjs` passed **36/36** on the running original app: signed ghost user/admin/superadmin/pending claims were denied by the new endpoint's fresh-account lookup, anonymous401 and POST405 included. The ghost UUID was confirmed absent from all four current live users before executing guarded probes.


### Not verified / do not claim complete live activation

- Direct Google editor interaction (browser opening timed out); actual Google print rendering and cell formatting attributes were verified instead.
- Production/Vercel deployment and real scheduled invocation timing. The closing branch was exercised with a controlled runtime clock, not by waiting for a Vercel invocation.

## 6. Existing auth/layout constraints retained

- Registration creates pending ordinary users; seed the first superadmin manually. API guards re-read the database and do not trust role/status claims from an unexpired JWT.
- Middleware is a page redirect layer, excludes `/api/*`, and is not the authorization boundary.
- Portal layout renders one AppShell. Every role has Buat Nomor Surat, Cari Surat and Register Surat; administrators add Riwayat Audit and superadministrators add Kelola Pengguna. Creation routes remain role-specific. Both header rows retain `h-16 shrink-0`.
- Document reads no longer need an anonymous RLS grant. The new migration removes the old public policy, and search polls fresh-authorized APIs. The separately approved full-register view remains all-approved-role read-only.
- **Pre-existing demotion redirect loop:** an old admin JWT can bounce `/dashboard` → `/admin` → `/dashboard` after the database role is demoted. Prior handoff suggested `/profile` as the fail-closed redirect target. This unrelated auth behavior was not changed in the register task.

## 7. File map and operational notes

| Path | Role |
|---|---|
| `supabase/schema.sql`, `seed.sql` | Base setup and first superadmin |
| `supabase/migrations/20261006_letter_register.sql` | Ledger, allocator, revisions, lease and service-only RPCs |
| `supabase/migrations/20261007_document_delete.sql` | Safe deletion, held slots, revision/lease-checked release and private reads |
| `src/lib/letter-fields.ts` | Pure structured-field/year/date validation and WIB today |
| `src/lib/letter-register.ts` | One-time real Sheets bootstrap |
| `src/lib/register-sheet.ts` | Taxonomy/date/number parsing and pure monthly projection |
| `src/lib/sheet-register.ts` | Pure source grid/theme/merge/dimension parser and view contract |
| `src/app/api/register/sheet/route.ts` | Approved all-role actual Sheets read endpoint |
| `src/components/SheetRegister.tsx`, `(portal)/register-sheet/page.tsx` | Source-shaped read-only table, month/day filters and visibility-aware polling |
| `src/lib/google-sheets.ts` | Google client, bounded B:M batches, lease and acknowledgement |
| `src/lib/resync.ts` | Shared persisted retry/status engine |
| `src/lib/supabase.ts` | Server-only service-role client and shared document types |
| `src/components/ClassificationInput.tsx` | Accessible code search plus options loading |
| `src/components/DocumentPortal.tsx` | Creation-only form |
| `src/components/DocumentSearch.tsx`, `DocumentsTab.tsx`, `(portal)/documents/page.tsx` | Shared scoped search/edit/retry/delete and isolated editor |
| `src/app/api/documents/delete/route.ts` | Scoped deletion, Google projection and truthful held/released response |
| `scripts/register-test.mjs`, `register-test.sql`, `register-delete-test.sql` | Disposable SQL allocation/deletion/privacy/concurrency regressions |
| `scripts/sheet-register-test.mjs` | Source-rendering date/number/Boolean/theme/offset/merge-tail regressions |
| `scripts/*test.mjs`, `check-env.mjs` | Pure/auth/routing/environment checks; OS env can override local-file values |
| `vercel.json` | Five-minute retry and WIB23:59 closing schedules |
| `docs/plans/2026-10-06-letter-register.md` | Approved design/contracts |

`npm run check:env` checks migration tables/columns, private-ID counter, register initialization/high-water state and RLS. Run it after the live migration. Do not expose service-role/private keys in diagnostics.

On Windows, quote paths containing `(portal)`. Restart `next dev` after route/component restructuring if webpack temporarily serves stale routes; browser smoke encountered transient 404s resolved by a restart. Stop dev before production build to avoid `.next` cache collisions. Browser `fill` on native date inputs was unreliable in this automation tool; using the native value setter plus input/change events exercised the actual React form instead.
