# Room Booking GraphQL API

[![CI](https://github.com/swarajladke/GraphQL-API/actions/workflows/ci.yml/badge.svg)](https://github.com/swarajladke/GraphQL-API/actions/workflows/ci.yml)

A backend for reserving shared resources — meeting rooms, desks, projectors — built with **Bun + TypeScript (strict)**, **GraphQL Yoga** (schema-first), **Prisma** and **PostgreSQL**.

The headline requirement: **two confirmed bookings for the same resource can never overlap**, while back-to-back bookings are allowed and cancelled slots are immediately reusable. That guarantee is enforced by the database, not by application convention.

---

## Quick start

```bash
# 1. Install
bun install

# 2. Environment
cp .env.example .env
cp .env.test.example .env.test

# 3. Postgres (docker compose maps it to host port 5433, plus a booking_test DB)
bun run db:up

# 4. Schema + client
bun run prisma:generate
bun run migrate:deploy

# 5. Optional demo data
bun run seed

# 6. Serve
bun run dev      # http://localhost:4000/graphql (GraphiQL enabled)
```

Run the tests (applies migrations to `booking_test`, then runs the suite):

```bash
bun run test        # prepare test DB + run everything
bun run typecheck   # tsc --noEmit, strict
```

---

## The overlap guarantee

There are three independent layers. Each one alone would be a bug waiting to happen.

### 1. Half-open intervals `[startTime, endTime)`

A booking owns its start instant but **not** its end instant. Two intervals overlap when:

```
a.start < b.end  AND  a.end > b.start        (both comparisons strict)
```

So `10:00–11:00` and `11:00–12:00` share only the instant `11:00`, which belongs to the second booking alone — back-to-back bookings are legal *by construction*, with no special case anywhere in the code. Using `<=`/`>=` here is the single most common bug in this kind of system.

This is implemented identically in three places, deliberately:

| Layer | Implementation |
| --- | --- |
| Pure logic | `overlaps()` in `src/lib/time.ts` |
| Query | `startTime: { lt: end }, endTime: { gt: start }` in `src/lib/booking-service.ts` |
| Constraint | `tstzrange(start_time, end_time, '[)')` in the migration |

### 2. Per-resource advisory lock (application layer)

The thing we must protect is the **absence** of rows in a time range. `SELECT ... FOR UPDATE` can only lock rows that *exist*, so a naive `SELECT conflicts → INSERT` lets N concurrent requests all read "no conflicts" and all insert.

`withResourceLock()` wraps the check-and-insert in a transaction holding `pg_advisory_xact_lock(namespace, hash(resourceId))`:

| Option | Verdict |
| --- | --- |
| `SELECT ... FOR UPDATE` on the parent `resources` row | Works, but locks a row that ordinary reads also touch, for the whole transaction |
| `SERIALIZABLE` isolation | Correct, but predicate conflicts surface as `40001` and the caller must implement a retry loop |
| **Transaction-scoped advisory lock keyed on `resourceId`** | **Chosen.** Precise (different resources never block each other), no retry loop, released automatically on COMMIT/ROLLBACK — even if the process dies |

### 3. Partial exclusion constraint (source of truth)

```sql
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist (
    "resource_id" WITH =,
    tstzrange("start_time", "end_time", '[)') WITH &&
  ) WHERE ("status" = 'CONFIRMED');
```

* `'[)'` — half-open, so back-to-back passes.
* `WHERE (status = 'CONFIRMED')` — a **partial** constraint. Cancelled bookings are not in the index at all, which is precisely what "cancelled slots are reusable" means, and it lets any number of cancelled rows stack on the same window.
* Requires the `btree_gist` extension so `=` on a `uuid` can sit in a GiST index next to the `&&` range operator.

Because this lives in the database, the guarantee survives a buggy resolver, a second service, a psql session, or perfectly-timed concurrency. `translateDatabaseError()` maps SQLSTATE `23P01` back to the same `BOOKING_CONFLICT` the application check produces, so **clients cannot tell which layer caught it** — that's the point.

> Prisma cannot express exclusion constraints, so it lives in a hand-written migration: `prisma/migrations/20260825120000_init/migration.sql`.

---

## API

SDL: [`src/schema/schema.graphql`](src/schema/schema.graphql)

### Queries

| Query | Purpose |
| --- | --- |
| `resources(first, after)` | Paginated resource list |
| `resource(id)` | One resource, with nested paginated `bookings` |
| `bookings(filter, first, after)` | Filter by `resourceId`, `status`, and overlap window `from`/`to` |
| `booking(id)` | One booking |
| `availability(resourceId, from, to)` | `isAvailable`, the `conflicts`, and the bookable `freeSlots` |

### Mutations

| Mutation | Notes |
| --- | --- |
| `createResource(input)` | Unique name, positive capacity |
| `createBooking(input)` | Conflict-checked under the resource lock |
| `rescheduleBooking(input)` | Re-runs the conflict check **excluding itself** |
| `cancelBooking(id)` | Sets `CANCELLED`, frees the slot, **idempotent** |
| `deleteBooking(id)` | Hard delete |

### Errors

Stable codes in `extensions.code`, so clients branch on data rather than message strings:

`BAD_USER_INPUT` · `NOT_FOUND` · `BOOKING_CONFLICT` · `CONFLICT`

`BOOKING_CONFLICT` also carries `extensions.conflictingBookingIds`. In production every *other* error is masked, so SQL and stack traces never reach a client.

### Example

```graphql
mutation {
  createBooking(input: {
    resourceId: "…"
    title: "Design review"
    startTime: "2026-09-01T10:00:00Z"
    endTime:   "2026-09-01T11:00:00Z"
  }) { id status }
}

query {
  availability(
    resourceId: "…"
    from: "2026-09-01T09:00:00Z"
    to:   "2026-09-01T17:00:00Z"
  ) {
    isAvailable
    conflicts { title startTime endTime }
    freeSlots { startTime endTime }
  }
}
```

---

## Rescheduling

`rescheduleBooking` runs the *same* conflict query as `createBooking` with one addition: `id != excludeBookingId`. Without that exclusion, extending `10:00–11:00` to `10:00–12:00` would collide with its own current row — the classic reschedule bug. Covered by `tests/reschedule.test.ts`.

Cancelled bookings cannot be rescheduled (`BAD_USER_INPUT`); create a new booking instead. A failed reschedule leaves the original window completely untouched, which is asserted explicitly.

---

## Cursor pagination

Keyset ("seek") pagination, ordered by `(startTime, id)`, with opaque base64url cursors encoding `startTime | id`.

Why not `OFFSET`?

* `OFFSET N` makes Postgres walk and discard N rows — page 500 is slow.
* `OFFSET` **drifts**: inserting an earlier booking between page fetches silently shifts every later page, so clients skip or repeat rows. `tests/pagination.test.ts` asserts stability across exactly that scenario.

The `id` tie-breaker makes the ordering a *total* order — `startTime` alone is not unique, and without it two bookings starting at the same instant can be skipped across a page boundary. Also tested.

One extra row is over-fetched (`take: first + 1`) to compute `hasNextPage` without a second query, and `totalCount` is a lazy field resolver so clients that don't select it never pay for the `COUNT(*)`.

### Indexing

| Index | Serves |
| --- | --- |
| `bookings_resource_status_start_idx` `(resource_id, status, start_time)` | Conflict detection and availability |
| `bookings_start_time_id_idx` `(start_time, id)` | The pagination keyset |
| `bookings_resource_start_idx` `(resource_id, start_time)` | Per-resource timelines |
| `bookings_no_overlap` (GiST) | The exclusion constraint itself |
| `resources_created_at_id_idx` | Resource pagination keyset |

---

## Time handling

* Stored as `timestamptz(3)` — absolute instants, never wall-clock.
* The `DateTime` scalar **rejects timestamps without an offset**. A bare `2026-09-01T10:00:00` would otherwise be read in the server's local timezone, making overlap behaviour depend on where the process runs. `Z` or `±HH:MM` is required.
* Always serialised back as UTC ISO-8601.
* A DB `CHECK` enforces `end_time > start_time`; the API also caps a single booking at 24h and an availability window at 90 days.

---

## Tests

70 tests across 6 DB-backed suites: they run real operations through the real schema and resolvers against real Postgres, skipping only the HTTP layer. Unit-testing the overlap maths alone would pass happily while the SQL predicate was wrong.

```
tests/overlap.test.ts       every geometric overlap case, back-to-back, 1ms overlap,
                            raw-SQL bypass attempt, input validation
tests/cancellation.test.ts  slot reuse after cancel, stacked cancellations,
                            idempotency, delete, FK cascade
tests/reschedule.test.ts    self-conflict exclusion, extend/shift, failed reschedule
                            leaves original intact, timestamps
tests/concurrency.test.ts   20-way race for one slot, chained partial overlaps,
                            concurrent reschedules, cross-resource parallelism
tests/pagination.test.ts    full walk, ordering, stability under insert, id
                            tie-breaks, filters, nested Resource.bookings
tests/availability.test.ts  gap computation, edge-touching, clipping, interval maths
```

Two highlights worth pointing at in review:

* **`tests/concurrency.test.ts`** — 20 simultaneous `createBooking` calls for the identical slot: exactly **one** succeeds, 19 get `BOOKING_CONFLICT`. A naive implementation passes every other file in the suite and fails this one. There is also a test that concurrent *back-to-back* bookings all succeed, proving the lock isn't so coarse that it creates false conflicts, and one proving different resources are not serialised against each other.
* **`tests/overlap.test.ts` → "the exclusion constraint blocks a raw SQL overlap too"** — inserts an overlapping row via raw SQL, bypassing every application check. If that insert succeeded, the guarantee would only be a convention.

Each test truncates with `TRUNCATE … CASCADE`. `scripts/prepare-test-db.ts` refuses to run against a database whose name doesn't end in `_test`.

### Verifying the invariants

Every core guarantee has been tested against negative mutations (sabotage tests) to confirm that the suite catches real invariant violations:

| Invariant under test | Sabotage performed | Result |
| --- | --- | --- |
| **Half-open interval bounds** | Changed `startTime: { lt }` to `lte` in conflict queries | `tests/overlap.test.ts` fails back-to-back slot filling |
| **Concurrency & exclusion** | Dropped `bookings_no_overlap` constraint + removed advisory lock | `tests/concurrency.test.ts` fails (multiple winners in 20-way race) |
| **Partial constraint (slot reuse)** | Recreated `bookings_no_overlap` without `WHERE (status = 'CONFIRMED')` | `tests/cancellation.test.ts` fails (cancelled slots cannot be re-booked) |
| **Reschedule self-exclusion** | Removed `id: { not: excludeBookingId }` filter | `tests/reschedule.test.ts` fails (booking conflicts with itself on extend/shift) |

---

## Layout

```
src/
  index.ts                 Bun.serve + Yoga, error masking, graceful shutdown
  context.ts               per-request context + request-scoped resource cache
  prisma.ts                singleton PrismaClient
  schema/
    schema.graphql         the contract (schema-first)
    index.ts               makeExecutableSchema, validated against resolvers at boot
  resolvers/
    index.ts               thin resolvers — they validate and delegate
    connections.ts         keyset pagination + filter → where translation
    scalars.ts             strict DateTime scalar
  lib/
    booking-service.ts     all business logic: locking, conflict checks, availability
    time.ts                half-open interval maths, validation, free-slot computation
    pagination.ts          cursor encode/decode, connection building
    errors.ts              typed GraphQL errors with stable codes
    db-errors.ts           SQLSTATE → domain error translation
    uuid.ts                ID guards (stops uuid cast errors leaking as 500s)
prisma/
  schema.prisma
  migrations/…/migration.sql   incl. btree_gist + the exclusion constraint
  seed.ts
tests/                     six DB-backed suites + shared helpers
scripts/                   db readiness, test-DB preparation, init SQL
```

Resolvers stay thin and the service layer owns the invariants, so the booking rules are testable without GraphQL and reusable from a future REST route, queue worker or cron job.

---

## Trade-offs and what I'd do next

* **Advisory lock over `SERIALIZABLE`** — avoids a retry loop; the exclusion constraint means correctness never depended on the lock anyway.
* **`resource` caching, not DataLoader** — a request-scoped `Map` kills the N+1 on `Booking.resource` with a fraction of the machinery. A real DataLoader is the next step if more nested relations appear.
* **No auth/tenancy** — out of scope. `Booking` would gain an owner and mutations an authorisation check.
* **Not yet built:** recurring bookings (the exclusion constraint already handles materialised occurrences), buffer/turnaround time between bookings (widen the range in the constraint), soft-delete for resources, and rate limiting + query-depth limits on the Yoga layer.
* **`cancelBooking` is idempotent** but `deleteBooking` is not — deleting twice is `NOT_FOUND`. Debatable; I chose to make destructive operations loud.

A written walkthrough of the implementation and key decisions is in [`WALKTHROUGH.md`](WALKTHROUGH.md).
