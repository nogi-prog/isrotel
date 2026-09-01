# App description

## problem
organizing comapny field trip that we don't know from each section and team who is actually go because it's
not all the company go. we need based on that to schedule stuff like buses, dorms, food ordering and etc

## types of users
- employee
- team leader
- sector leader
- division leader
- trip organizer (TO) - also holds a sector leader's position in the command chain
- CEO (מפמ״ר) - the manager of all the users in the company; system management stays with the TO

## use cases
### user login to the app for the first time
- the user need to fill the details: 
    - first and last name
    - gender
    - company id (7 digits)
    - a password (min 8 chars, letters + digits)
    - who is your manager (from the db)
    - diet prefersion (all, vegeterian, vegan)

- the server save the details and the realtionships in the db
- the manager of the new user approve the registration

### returning user logs in / forgot password
- login is company id + password (two-step form: id first, then password)
- a user who forgets their password requests a reset; it goes to the TO (not their manager - this
  is system administration, not org authority)
- the TO resolves the request and gets a one-time temporary password to hand the user out of band
  (in person / by phone) - it is never stored or notified in plain text
- the user must set their own password immediately after logging in with the temporary one

### TO creates new trip
- TO (trip organizer) create new trip
- TO set cycles of exits, for each one a date for exit

### user sign for trip
- user sign for specific cycle
- user dorms
    - the user need to choose with whom he wants to sleep with (list of max 3)
    - boys only sleep with boys, girls with girls
    - employee with employee, managers (team, sector, division) with managers
    - employee only can choose people from the same sector
- user need to approve the diet prefersion
- manager of the user need to approve the requests of the people he manages (team - sector - division)

### TO requests bus arrangment
- the TO locks the trip's busses arrangment
- system anaylzing how to split the pepole according to the bus capacity (const 50)
- everyone who sign to the system gets in its trip summary to what bus it schedule (each bus got a number)
- TO gets the full list, managers gets the list of their people with where they're positioned

### TO requests dorms arrangment
- the TO locks the trip's dorms arrangment
- system anaylzing which people need to be with which people according to available rooms in the dorms (explain later)
- If there are problems with some people that can't get even one of their prefernces, their manager gets notification to solve the issue with possible arrangments with other people from the same sector
- TO gets the full list, managers gets the list of their people with where they're positioned

### TO sets the available dorms
- the TO adds structures
- each structure is only one gender (boys or girls)
- each structure has rooms
- every room has number of beds

### TO ask for food supply
- the TO gets the list of how many meals he needs to order according to the type


## tech definitions

### stack
| layer | choice | why |
| --- | --- | --- |
| runtime | Node.js 24 (native TypeScript type-stripping) | no build step in dev, `npm run dev` runs `.ts` directly |
| server | Express 5 + Zod | small surface, async errors handled natively, all input validated at the edge |
| database | SQLite via the built-in `node:sqlite` | zero native deps and zero setup — the DB is a single file |
| client | React 19 + Vite 7 + React Router 7 | SPA, `dir="rtl"` at the document root |
| auth | company id + password, scrypt-hashed (`node:crypto`), HMAC-SHA256 signed session token, 14-day TTL | no external dependency (no IdP in scope); passwords are salted/hashed so a full DB leak doesn't expose them; forgotten passwords are reset by the TO, not self-service |
| tests | `node:test` | 72 tests: allocation engines, the `users` rebuild migration, and full API integration against an in-memory DB |

### org hierarchy
The org tree **is** the manager chain (`users.manager_id`) — there is no separate units table
to keep in sync. A person's team/sector/division is the nearest ancestor (or self) whose role is
`team_leader` / `sector_leader` / `division_leader`, resolved with a recursive CTE. Managers carry
the display name of the unit they command in `users.unit_name`.

At registration a person may only pick a manager **one level up** (`PARENT_ROLES` in `types.ts`),
which keeps the chain well-formed by construction:

| registering as | manager must be |
| --- | --- |
| חייל | ר״צ |
| ר״צ | רמ״ד **or** אופרטיבי |
| רמ״ד | רת״ח |
| רת״ח | מפמ״ר |
| מפמ״ר | — (root of the chain) |

`GET /auth/managers?role=<role>&q=<search>` returns only the eligible level(s), so the client cannot
offer an invalid choice, and `POST /auth/register` re-validates it server-side.

**Bootstrap fallback**: if the parent level has no approved user yet — a רת״ח registering before any
מפמ״ר exists — the registrant is not dead-ended. They register as a root (`manager_id = NULL`) and
the response says so (`rootRegistration: true` plus a Hebrew `note`). Root registrations, including
every מפמ״ר, are **approved by the אופרטיבי**: the spec's rule ("the manager approves the
registration") has nobody to point at, and the אופרטיבי already holds the administrative role, so
this keeps a human in the loop rather than silently auto-approving.

### the two roles that are not one level of the ladder
- **אופרטיבי — administrative *and* a רמ״ד.** It owns system management (creating trips, the locks,
  the food report, approving root registrations) *and* holds a רמ״ד's position in the command chain:
  it commands a מדור, can be assigned a trip's signing mission, and signs its own subtree exactly
  like any רמ״ד. `resolveUnits` therefore resolves a person's **sector** to the nearest ancestor whose
  role is `sector_leader` **or `to`**, which is what makes the "roommates from the same מדור" rule and
  the bus allocation's sector grouping work for people under a TO.
- **מפמ״ר — the top of the chain, with no administrative powers.** Everyone is under them
  transitively, so they can be assigned the signing mission (their subtree is the whole company), but
  `isTripOrganizer` stays `role === 'to'` and no TO-only screen opens for them.

`users.role` deliberately carries **no `CHECK` constraint**. SQLite cannot alter one in place, so
every role addition would mean rebuilding the table (it has now happened twice); the `Role` union and
the Zod enums validate at the edge instead. The `gender` / `diet` / `status` CHECKs stay — those
enums are stable.

### rank groups (for dorm separation)
`employee` → `soldier`; every other role → `commander`. The אופרטיבי and the מפמ״ר are grouped with
the commanders (they are not חיילים). A room only ever holds one rank group.

### allocation engines
Both engines are pure functions with no DB access, which is what makes them unit-testable:

- **`services/busAllocation.ts`** — bin-packs at capacity 50 (configurable per trip). Tries a whole
  sector per bus first, falls back to whole teams (best-fit-decreasing), and splits a team only when
  it cannot fit anywhere — reporting every split it was forced to make. Hits the minimum bus count on
  the seed data with zero splits.
- **`services/dormAllocation.ts`** — partitions people into (gender × rank group) pools, divides the
  rooms between the pools by unmet bed demand, clusters roommate preferences with union-find (mutual
  preferences merged before one-directional ones), then packs clusters into rooms largest-first. When
  a cluster must be split it peels off the most preference-connected subgroup instead of scattering
  people. Achieves ~85% preference satisfaction on the seed data.

The three hard constraints — one gender per structure, one rank group per room, never more people
than beds — are enforced structurally and asserted in the tests; only preference satisfaction is
best-effort.

### trip state machine
`trips.state`. **`LAUNCHED`** is the entry state, set the moment the TO creates the trip; `CLOSED`
is terminal. Intermediate states are not yet defined — the bus/dorm locks remain separate
timestamps rather than states, so the pipeline works today without pre-committing to names.

Creating a trip takes exactly three inputs: the **launch date**, the **leaders assigned the
signing mission**, and the **exit cycles** (פעימות). The name is generated from the id (`גלישה #1`),
and there is no destination, description, or capacity field — capacity is the system-wide constant 50.
Creation lives on its own screen (`/manage/new`) rather than inline in the trip list, so the page
shows only the trip being created.

In `LAUNCHED` the TO's only action on the trip is `POST /trips/:id/notify-leaders`, which messages
the assigned leaders that they must sign their people. It is re-sendable as a reminder. **The TO
never signs anyone up.**

### cycle naming (פעימות)
A cycle carries an **exit date only** — a פעימה is a single-day wave, so there is no return date
anywhere in the system. The food report follows from that: `portions = participants × 3 meals`, with
no trip-length arithmetic.

A cycle's name is **derived from its place in the exit order, never typed in**: the wave that leaves
first is always **חלוץ**, and the rest are **פעימה 1**, **פעימה 2**, and so on. `cycleName(index)` in
`types.ts` is the single definition (mirrored in `web/src/lib/he.ts` for the live preview in the
form), and `renumberCycles(tripId)` re-derives every name after an insert, a date change, or a
delete — so moving a cycle earlier makes it the חלוץ and renumbers the others, and deleting one
closes the gap. A trip must be created with at least one cycle (the חלוץ), and two cycles may not
share an exit date.

### submission, late additions, and the frozen roster
Two independent submissions, both reversible:

| who | action | meaning |
| --- | --- | --- |
| מפקד with signing authority | `POST /trips/:id/submit-signing` (`trip_submissions` row) | "my list is ready" — tells the אופרטיבי, but does **not** close the list |
| אופרטיבי | `POST /trips/:id/submit` (`trips.submitted_at`) | **freezes the roster for everyone** |

The requirement this serves: *a person approved into your unit after you submitted must still be
addable.* `GET /trips/:id/signable` returns `lateAdditions` — the ids of approved people in the
viewer's subtree with `approved_at > their own submitted_at` and no signup yet. The signing screen
surfaces them in a dedicated card so the מפקד does not have to spot a new name in a long table, and
adding them uses the ordinary `POST /signups`. It works right up until the אופרטיבי submits.

**The freeze is on the roster, not on personal details.** `signups.routes.ts` therefore has two
gates rather than one:

- `assertRosterOpen` — add/remove people, approve/reject, delegate. Blocked by state ≠ `LAUNCHED`,
  the bus/dorm locks, **or** `trips.submitted_at`.
- `assertDetailsOpen` — `PATCH /my-signup` only. Deliberately ignores `submitted_at`: a חייל must
  still pick roommates and confirm diet after the trip is submitted, because the dorm allocation
  consumes exactly that and runs afterwards.

Both submissions can be withdrawn (`DELETE`), mirroring the reversible bus/dorm locks — one
premature click should never strand a trip. Approving a registration notifies every ancestor who
has authority on an open trip **and has already submitted** (kind `late_addition`).

`trip_submissions.submitted_at` and `users.approved_at` are written with millisecond precision
(`NOW_MS` in `types.ts`) rather than `datetime('now')`. With second resolution, an approval landing
in the same second as a submission fails `approved_at > submitted_at`, so the manager got the
notification but the person was never highlighted — an alert pointing at nothing. Both timestamps
share the `'YYYY-MM-DD HH:MM:SS.mmm'` format, which still compares correctly against older
second-resolution rows.

### who signs whom
Employees cannot sign themselves up. `lib/signing.ts` resolves authority:

| actor | authority | effect |
| --- | --- | --- |
| מפמ״ר / רת״ח / רמ״ד / **אופרטיבי** — **assigned to the trip** | `leader` | signs their whole subtree; counts immediately (`approved`) |
| מפקד who received a delegation | `delegated` | signs their own subtree; waits for the delegator's approval (`pending`) |
| any of those leaders **not** assigned | — | blocked |
| חייל | — | blocked; may only complete their own details |

`SIGNING_LEADER_ROLES` is `sector_leader`, `division_leader`, `to`, `ceo` — every role that commands a
unit above team level. The אופרטיבי is in that list because it is also a רמ״ד (see above): being the
one who *publishes* the trip does not exempt it from signing its own מדור, and being assigned is
still required.

`trip_leaders` records the mission; `trip_delegations` records a leader handing signing downward.
Delegation cascades through the chain (a DL can delegate to its SLs, who can delegate to their TLs),
and revoking it immediately removes the delegate's authority.

Once nominated, the employee logs in to pick up to 3 roommates and confirm their diet via
`PATCH /trips/:id/my-signup` — the only trip endpoint they can call. They cannot add or remove
themselves. Signup rows carry `created_by` (the manager who nominated them), so provenance is
always recoverable.

Allocations still consume only `status = 'approved'` signups, so a delegated TL's proposals stay out
of the buses and dorms until the delegating leader confirms them.

### deleting a trip
`DELETE /trips/:id` (TO only) really deletes, signups and all — the trip list has a delete button per
trip, so refusing on non-empty trips would make it useless. Every child row goes by
`ON DELETE CASCADE`; the one thing cascade cannot reach is `notifications`, which has no FK to trips,
so the handler also clears the rows whose `link` points at that trip and would otherwise dangle. The
response reports what it removed (`deleted.signups` / `cycles` / `structures` / `notifications`) so
the client can say so out loud, and the client confirms before firing.

### locking model
`buses_locked_at` / `dorms_locked_at` on the trip. Locking computes the allocation, persists it,
notifies every participant and their managers, and freezes signups. Both locks are reversible
(`/unlock`) so the TO can fix data and re-run. Only signups **approved by a manager** ever enter an
allocation.

### mobile
One breakpoint at **640px** in `web/src/styles.css`, plus a narrow tightening at 380px. Two things
carry the weight:

- **Tables become cards.** `thead` is hidden, every row becomes a bordered block, and each cell's
  column name is printed from its own `data-label` via `td::before { content: attr(data-label) }`.
  Horizontal scroll was already technically present (`.table-wrap`), but an 8-column table on a
  390px screen pushes exactly the useful columns — status and the action buttons — off screen, so
  side-scrolling is not a real answer. Key/value tables (no `thead`, a `th` per row) are detected
  with `tbody tr:has(> th)` and stay as one label-versus-value line instead.
- **Touch targets.** `.btn`, `.btn--sm`, `.navlink`, `.tab`, inputs and combobox options are all at
  least 44px tall on mobile — `btn--sm` included, because "small" is a desktop density notion. Form
  controls also go to `font-size: 16px`, the threshold below which iOS Safari zooms the page on
  focus. Checkboxes stay 20px on purpose: the tap target is the surrounding `label.checkbox` (57px
  tall), and inflating the box itself would just look wrong.

The nav strip and the tab strip scroll horizontally rather than wrapping, so the sticky header stays
short, and `min-height` uses `dvh` so the mobile URL bar does not make the layout jump.

### permission scoping
Every list endpoint is scoped server-side, not in the client: the TO sees everything, a manager sees
only themselves plus their recursive subordinates, and a soldier sees only their own summary.

## language
- the system is in full hebrew
- translations:
    - employee - חייל
    - team - צוות
    - sector - מדור
    - division - תחום
    - TO - אופרטיבי
    - team leader - ר״צ
    - sector leader - רמ״ד
    - division leader - רת״ח
    - cycle - פעימה
    - establish - חלוץ
    - CEO - מפמ״ר