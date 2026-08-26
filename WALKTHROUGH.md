# Walkthrough — Room Booking GraphQL API

A written walkthrough of the implementation and the decisions behind it. It doubles as the script for the 5–10 minute video: the six sections below map to roughly one minute each.

---

## 1. The one hard problem

Everything else in this assignment is CRUD. The actual problem is this:

> Two confirmed bookings for the same resource must **never** overlap — but back-to-back bookings must be allowed, and a cancelled booking must free its slot immediately.

Those three clauses pull in different directions, and each has a classic failure mode:

1. **Overlap** fails under concurrency — two requests both read "no conflict", both insert.
2. **Back-to-back** fails on an off-by-one — one `<=` instead of `<` and `11:00–12:00` is rejected because something else ended at `11:00`.
3. **Cancelled slots** fail if the uniqueness rule ignores status — the cancelled row keeps blocking the window forever.

So I designed around those three failure modes rather than around the CRUD surface.

---

## 2. Half-open intervals — the modelling decision

A booking is the interval `[startTime, endTime)`. It **owns its start instant but not its end instant**.

Overlap becomes:

```
a.start < b.end  AND  a.end > b.start
```

Both comparisons strict. `10:00–11:00` and `11:00–12:00` share only the instant `11:00`, which belongs solely to the second booking, so they don't overlap.

The important consequence: **back-to-back is not a special case.** There is no `if (adjacent) allow` branch anywhere in the codebase — it falls out of the model. Failure mode #2 is designed away rather than patched.

The same rule appears in exactly three places, and they must agree:

| Where | Form |
| --- | --- |
| `src/lib/time.ts` | `overlaps()` — pure function |
| `src/lib/booking-service.ts` | `startTime: { lt: end }, endTime: { gt: start }` |
| `migration.sql` | `tstzrange(start_time, end_time, '[)')` |

Related: the `DateTime` scalar **rejects timestamps with no UTC offset**. `2026-09-01T10:00:00` would be parsed in the server's local timezone, so overlap behaviour would depend on where the process runs — and in CI vs. laptop that's a heisenbug. `Z` or `±HH:MM` is mandatory, and everything is stored as `timestamptz`.

---

## 3. Concurrency — where the naive version breaks

The obvious implementation:

```ts
const conflicts = await prisma.booking.findMany({ /* overlap */ })
if (conflicts.length) throw conflict()
return prisma.booking.create({ /* … */ })
```

This passes every single-threaded test and **double-books under load**, because all N requests run their `SELECT` before any of them `COMMIT`s.

Row locks don't save you either: the thing that needs protecting is the **absence** of rows in a range, and you cannot lock a row that doesn't exist yet.

I evaluated three fixes:

| Option | Why not / why |
| --- | --- |
| `SELECT … FOR UPDATE` on the parent `resources` row | Works, but locks a row that ordinary reads touch, for the whole transaction. Coarse. |
| `SERIALIZABLE` isolation | Correct, but predicate conflicts arrive as `40001` and every caller needs a retry loop. |
| **`pg_advisory_xact_lock(ns, hash(resourceId))`** | **Chosen.** Precise — Room A and Room B never block each other. No retry loop. Released automatically on COMMIT/ROLLBACK, even if the process is killed. |

That's `withResourceLock()` in `src/lib/booking-service.ts`.

### …and then I assumed the lock would fail anyway

The lock makes conflicts *rare*. It does not make double-booking *impossible* — a second service, a migration script, or a psql session would bypass it entirely. So the real guarantee is a **partial exclusion constraint**:

```sql
EXCLUDE USING gist (
  resource_id WITH =,
  tstzrange(start_time, end_time, '[)') WITH &&
) WHERE (status = 'CONFIRMED')
```

* `'[)'` — the same half-open semantics, now enforced by Postgres.
* `WHERE (status = 'CONFIRMED')` — the constraint is **partial**, so cancelled rows aren't in the index at all. That single clause is the entire answer to failure mode #3: cancelling frees the slot instantly, and any number of cancelled bookings can stack on the same window.
* Needs the `btree_gist` extension so `=` on a `uuid` can live in a GiST index beside `&&`.

Prisma can't express exclusion constraints, so it's a hand-written migration. `translateDatabaseError()` maps SQLSTATE `23P01` back to the same `BOOKING_CONFLICT` the application check produces — so a client **cannot tell which layer caught it**. That's deliberate: the DB is the source of truth, the lock exists to produce friendly errors rather than constraint violations.

---

## 4. Rescheduling — the self-conflict trap

`rescheduleBooking` runs the *identical* conflict query as `createBooking`, plus one clause: `id != excludeBookingId`.

Without it, extending `10:00–11:00` to `10:00–12:00` collides with its own current row and the API rejects a perfectly valid edit. It's a one-line bug with a very confusing symptom, so it has dedicated tests: extend, shift-by-30-minutes, and reschedule-to-the-identical-window.

Other decisions here:

* Cancelled bookings **cannot** be rescheduled — resurrecting a cancelled booking silently is surprising; create a new one.
* A failed reschedule must leave the original window untouched. The whole operation runs in the transaction, and a test asserts the original `startTime`/`endTime` after a rejected move.
* The resource id is read once *outside* the lock only to know **which** lock to take, then everything is re-read inside the transaction. That value is never trusted.

---

## 5. Pagination and indexing

Keyset pagination ordered by `(startTime, id)`, cursors are opaque base64url of `startTime | id`.

Why not `OFFSET`:

* `OFFSET N` makes Postgres walk and discard N rows.
* More importantly it **drifts**. Insert an earlier booking between page 1 and page 2 and every later page shifts — the client silently re-sees or skips rows. `tests/pagination.test.ts` reproduces exactly that scenario and asserts the cursor version stays correct.

The `id` tie-breaker matters: `startTime` isn't unique, and without a *total* order two bookings at the same instant can be dropped across a page boundary. Also tested.

Small touches: `take: first + 1` over-fetches one row so `hasNextPage` costs no second query, and `totalCount` is a lazy field resolver so clients that don't ask for it never pay for `COUNT(*)`.

Indexes follow the actual access patterns: `(resource_id, status, start_time)` for conflict detection and availability, `(start_time, id)` for the pagination keyset, `(resource_id, start_time)` for per-resource timelines, plus the GiST index behind the exclusion constraint.

---

## 6. Structure, and how I tested it

Resolvers are thin: validate, delegate, return. All invariants live in `src/lib/booking-service.ts`, so the booking rules are testable without GraphQL and reusable from a future REST route or queue worker. `src/lib/uuid.ts` guards ID inputs so a bad id becomes `BAD_USER_INPUT` instead of a leaked Postgres cast error. Errors carry stable codes (`BAD_USER_INPUT`, `NOT_FOUND`, `BOOKING_CONFLICT`, `CONFLICT`) so clients branch on data, not on message text; everything else is masked in production.

**Every test is DB-backed** — real schema, real resolvers, real Postgres, only the HTTP layer skipped. That's a deliberate choice: unit-testing `overlaps()` in isolation passes happily while the SQL predicate is wrong, and the SQL predicate is where the risk lives.

The two tests I'd point at in review:

1. **20 concurrent `createBooking` calls for the identical slot → exactly one succeeds, 19 get `BOOKING_CONFLICT`.** The naive implementation passes every other file in the suite and fails this one. Its mirror image also matters: concurrent *back-to-back* bookings must **all** succeed, proving the lock isn't so coarse that it invents false conflicts — and bookings on different resources must not serialise against each other.

2. **"The exclusion constraint blocks a raw SQL overlap too."** It inserts an overlapping row via raw SQL, bypassing every application-level check. If that insert succeeded, "can never overlap" would be a convention rather than a guarantee.

Beyond those: every geometric overlap relationship (contained, containing, shared start, shared end, 1ms of overlap), stacked cancellations, cancel idempotency, FK cascade, reschedule self-conflict, pagination stability, and free-slot computation with clipping and merging.

---

## Known limits

Honest list, in the order I'd tackle them:

* **No auth or tenancy** — `Booking` needs an owner and mutations an authorisation check.
* **No rate limiting or query-depth/complexity limits** on the Yoga layer — needed before this faces the internet.
* **Request-scoped `Map` instead of DataLoader** — it removes the N+1 on `Booking.resource`, but a real DataLoader (batching, not just caching) is the right answer once more nested relations exist.
* **No recurring bookings.** The constraint already handles materialised occurrences, so this is an API-surface problem rather than a correctness one.
* **No buffer/turnaround time** between bookings — would mean widening the range inside the exclusion constraint, which is a one-line change plus a migration.
* **`cancelBooking` is idempotent, `deleteBooking` is not.** Deliberate: I want destructive operations to be loud. Debatable.
