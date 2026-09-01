# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Hebrew/RTL system for organizing a company field trip: who's going, in which exit wave (פעימה),
on which bus, rooming with whom, and how many meals to order. The full functional spec — user
roles, the org hierarchy, and the step-by-step workflow — is in [ARCHITECTURE.md](./ARCHITECTURE.md);
read it before touching auth, signing, or allocation logic, since the domain rules are intricate
and not guessable from the code alone.

## Commands

```bash
npm install
npm run seed          # demo data: full org tree, one trip, 2 cycles, 4 dorm structures
npm run dev           # server on :4000, client on :5273, run together (needed for the client to work)
npm test              # 113 tests: allocation engines, migrations, full API integration (server workspace)
npm run typecheck     # server + web
npm run build         # server then web; server serves the client from web/dist
npm start             # run the build
npm run reset         # wipe the db and reseed
```

- Single test file: `node --experimental-strip-types --test server/src/services/busAllocation.test.ts`
  (run from repo root; swap in `api.test.ts`, `db/migrate.test.ts`, or `dormAllocation.test.ts`).
- Node.js 24+ required — the server runs `.ts` directly via native type-stripping, no build step in dev.
- Demo logins (after `npm run seed`): personal numbers `4000000`–`4200002`, password `Demo1234` for
  all of them — see README.md for the role-to-number table. Login is personal number + password.

## Architecture

**Stack**: Express 5 + Zod (server), React 19 + Vite 7 + React Router 7 (client, SPA, `dir="rtl"`),
SQLite via `node:sqlite` (single file at `server/data/trip-organize.db`, override with `DB_FILE`),
HMAC-signed session token (no IdP). `api/index.js` is a thin Vercel serverless entrypoint wrapping
the same Express app for deployment; `vercel.json` routes around it.

**Auth is company id + password** (`server/src/lib/password.ts`, `routes/auth.routes.ts`): passwords
are scrypt-hashed with a per-user salt (`users.password_hash`), so a full DB leak doesn't expose
them in plain text. Login is a two-step form (id, then password) with an in-memory lockout after 5
failed attempts per company id. There's no self-service reset: "forgot password" opens a
`password_reset_requests` row that only the TO can resolve — resolving generates a one-time temp
password returned *only* in that API response (never stored or notified in plain text) and sets
`users.must_change_password`, which forces a password change on next login before the app is usable
(`user.mustChangePassword` gates the client, checked in `App.tsx` the same way `user.status` does).
Accounts created before this feature have `password_hash = NULL` and can't log in until a TO resets
them — this is intentional (knowing someone's company id must never be enough to claim their
account). `POST /auth/debug-login` is a password-free login used only by the dev quick-login panel
(`DebugBar`), 404s when `NODE_ENV=production`, same guard as `/auth/debug-users`.

**Org hierarchy is implicit**: there is no units table. `users.manager_id` *is* the org tree; a
person's team/sector/division is the nearest ancestor (or self) with the matching leader role,
resolved via a recursive CTE. Registration only allows picking a manager one level up
(`PARENT_ROLES` in `types.ts`), which keeps the chain well-formed by construction. The אופרטיבי
(TO) is a special case: administrative *and* a רמ״ד simultaneously — `resolveUnits` treats `to`
as a sector-leader-equivalent so "same sector" rules work for people under it. The מפמ״ר (CEO) is
the root of the chain with no administrative powers.

**Allocation engines are pure functions, no DB access** (this is deliberate, for unit-testability):
- `server/src/services/busAllocation.ts` — bin-packs at capacity 50, whole-sector-per-bus first,
  falls back to whole teams, splits a team only as a last resort.
- `server/src/services/dormAllocation.ts` — partitions by (gender × rank group), clusters roommate
  preferences with union-find, packs clusters largest-first into rooms.

Hard constraints (one gender per structure, one rank group per room, beds ≥ occupants) are
structural and asserted in tests; preference satisfaction is best-effort only.

**Trip lifecycle**: `trips.state` starts at `LAUNCHED` (set on creation) and ends at `CLOSED`; the
bus/dorm locks (`buses_locked_at` / `dorms_locked_at`) are separate reversible timestamps, not
states. Two independent, both-reversible submission steps exist — a leader's
`POST /trips/:id/submit-signing` (informational) vs the TO's `POST /trips/:id/submit`
(`trips.submitted_at`, freezes the roster). `signups.routes.ts` enforces this with two gates:
`assertRosterOpen` (blocked by state/locks/`submitted_at`) and `assertDetailsOpen` (roommate/diet
edits, deliberately ignores `submitted_at` since dorm allocation depends on those fields being
completable after submission). Late-approved people are surfaced to their leader as `lateAdditions`
via `GET /trips/:id/signable` and remain addable until the TO submits.

**Who can sign whom** (`server/src/lib/signing.ts`): a leader assigned the trip's signing mission
signs their whole subtree immediately (`approved`); a leader who received a delegation signs their
own subtree pending the delegator's approval; employees can never sign themselves, only complete
their own roommate/diet details via `PATCH /trips/:id/my-signup`.

**Cycle naming (פעימות) is derived, never typed in**: first-to-leave is always חלוץ, then פעימה 1,
פעימה 2, etc., re-derived by `renumberCycles` on every insert/date-change/delete. A cycle has an
exit date only — no return date, so meal counts are `participants × 3` per cycle, not trip-length
arithmetic.

**Permission scoping happens server-side** on every list endpoint, not in the client: TO sees
everything, a manager sees themselves plus recursive subordinates, a soldier sees only their own
summary.

## Workflow

- After finishing a feature, ask the user whether to push it, and if they agree, push it to `main`
  on GitHub.

## Operational notes

- `users.role` intentionally has no `CHECK` constraint (SQLite can't alter one in place, and it's
  been rebuilt twice already) — `Role`/Zod enums validate at the edge instead. `gender`/`diet`/
  `status` CHECKs remain since those enums are stable.
- `npm audit` flags two high-severity `react-router` advisories; both are about RSC mode, which
  this SPA doesn't use, and no fixed version exists on the 7.x branch yet.
- `SESSION_SECRET` defaults to a dev secret — must be set via env var in production.
- The login lockout counter (`server/src/lib/password.ts`) is an in-memory `Map`, per server
  process — fine for a single-instance deployment, but resets on restart and wouldn't be shared
  across multiple instances.
- Mobile breakpoint is 640px (`web/src/styles.css`): tables collapse to cards via `data-label`, all
  touch targets are ≥44px including `btn--sm`.
