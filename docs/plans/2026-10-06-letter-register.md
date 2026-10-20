# Monthly Letter Register Implementation Plan

> Historical completed plan. The current deletion/search/privacy contracts supersede old export/Realtime references; see README/HANDOFF and `20261007_document_delete.sql`.

**Goal:** Replace generic document entry with the existing JULI/AGUSTUS B–M letter register, keeping unique numbers across dates and years.

**Architecture:** PostgreSQL is the sole allocator. Keep numeric `documents.id` as a private row key and add a unique text `surat_number` for ordinary and emergency suffixed numbers. Import existing B–M rows into a dated slot ledger once; Google Sheets is an idempotent monthly projection, never an allocator. Existing sheet records are preserved as occupied imported slots, not fabricated application submissions.

**Tech Stack:** Next.js App Router, React, TypeScript, PostgreSQL PL/pgSQL, Supabase REST, existing googleapis client.

## Approved business rules
- Search KD Surat by classification code or description from Acuan No Surat.
- Form: KD Surat, automatic Nomor Surat, KD Satker (initially Pusdatin), Hal, Tujuan Surat, one Ket. (CAT/SRIKANDI/EOFFICE/MANUAL), date and month, HARI INI.
- Admin/superadmin can add satker options. Users cannot change the catalog.
- Use Asia/Jakarta civil dates. Month must match the selected date.
- Take the first unused numbered slot on the requested date.
- A future submission reserves a total of 45 ordinary slots for today and intervening dates, but not for the target date. Existing used slots count towards that total.
- Close at 23:59 WIB with at least 15 unoccupied slots; a day already fixed at 45 does not receive additional slots. Closing is idempotent and catches up missed scheduler runs.
- Once a later day's range exists, earlier ranges cannot grow or renumber existing letters. Exhausted days permit explicit admin/superadmin emergency allocation using the day's last base number with .a, .b, ... .z, .aa, ...; require an emergency reason and record it.
- Numbers continue across years. Only the configured 2026 spreadsheet is writable in this change; reject other-year submissions clearly rather than overwrite a month from a different year.
- Manual allocation is prohibited. Sharing restrictions must be maintained in Google Drive by its owner; app roles do not control Drive permissions.

## Integration contracts
- `DocumentRow`: existing numeric id plus `surat_number: string`, `letter_date: string | null`; `title` stores Hal; metadata is `{kdSurat, kdSatker, tujuanSurat, ket}` (legacy metadata remains readable).
- `GET /api/documents/options`: `{ classifications: {code, description}[], satkers: {id, name}[], today: YYYY-MM-DD, year: 2026 }`.
- `POST /api/satkers`: admin/superadmin, `{name}`, creates a unique case-insensitive option.
- `POST /api/documents/generate`: `{kdSurat, kdSatker, hal, tujuanSurat, ket, date, month, emergency?: boolean, emergencyReason?: string}`; number allocated only on server. Return full document, message and syncWarning. No ordinary user may request emergency numbers.
- Existing edit/resync APIs address the private numeric row key. Official number/date cannot be edited outside allocation; metadata edits are validated against the catalog and synchronize the same numbered row, not append a correction.
- SQL migration exports `initialize_letter_register(p_rows jsonb, p_today date)`, `create_registered_document(p_user_id uuid, p_date date, p_title text, p_metadata jsonb, p_emergency boolean default false, p_reason text default null)`, `close_letter_days()` and a global Sheets lease API. All mutating RPCs are service-role-only and recheck approved users where applicable.
- `google-sheets.ts`: `fetchClassifications()`, `readExistingRegister()` returns `{number, date, values, occupied}[]`; `syncRegisterMonth(month: number)` writes a coherent SQL snapshot, preserving imported values and matching B–M headers, date merges, column widths, checkboxes and formatting. `syncDocumentRow(doc)` performs idempotent numbered-row synchronization for dated documents; legacy Sheet1 records stay read-only. `syncRegisterCalendar()` projects pending calendar changes, including empty reserved rows. A 240-second global lease covers Google's 180-second processing limit; J:M text annotations remain intact.
- Parent owns SQL/types/orchestration/tests/docs; UI slice owns DocumentPortal, DocumentsTab, dashboard props/admin form exposure; Sheets slice owns google-sheets.ts and pure sheet parsing helper; API slice owns generate/update/options/satkers/list/export/resync/cron and resync.ts. No shared file edits across slices.

## Tasks and checks
1. Write actual PostgreSQL allocation regression checks first and observe current allocator cannot satisfy dated reservation behavior. Use a throwaway local PostgreSQL cluster, not the live counter.
2. Add an additive migration and matching fresh schema setup. Exercise ordinary allocation, concurrent calls, 45-slot future reservation, 15-unused close, fixed days, backdating, exhausted emergency suffixes, unauthorized emergency calls, and duplicate import rejection.
3. Implement Sheets parsing/projection with read-only live taxonomy/template inspection, then smoke against a disposable spreadsheet copied from current template; never consume live letter numbers for tests.
4. Implement the form and catalog management with existing styles, native date/month controls, searchable accessible classification input, and explicit emergency confirmation for administrators.
5. Replace generic generate/update flows; validate against real taxonomy/satker, bootstrap once from B–M, allocate atomically, persist before sync; synchronize pending and failed documents and calendar updates through the existing cron.
6. Run typecheck, lint, existing authorization tests and runtime/browser smoke; record only observed evidence. Update README/HANDOFF after smoke proof.

## Deployment prerequisite
Resolved on 2026-10-06: the user applied the migration through Supabase SQL Editor; read-only queries confirmed the ledger state and new document columns. The supplied disposable workbook `1If1iXh3WM0BdkJYtiQNGA9tzR9N-BWu0xZJhbyPCPHc` passed actual-source write/edit/retry, 45/15 reservations, historical emergency, calendar projection, O:Z preservation and Google-rendered PDF checks against isolated PostgreSQL/PostgREST. Original Sheets and production numbers were not mutated. Production deployment/scheduler and live Realtime delivery remain separate unverified operations.
