import { Prisma, type Booking, type PrismaClient } from "@prisma/client"
import { badUserInput, bookingConflict, notFound } from "./errors.ts"
import { translateDatabaseError } from "./db-errors.ts"
import { assertUuid } from "./uuid.ts"
import {
	assertValidAvailabilityWindow,
	assertValidBookingInterval,
	computeFreeSlots,
	type Interval,
} from "./time.ts"

export type Tx = Prisma.TransactionClient

const LOCK_NAMESPACE = 4_242 // arbitrary but fixed: avoids clashing with other advisory-lock users

/**
 * Run `fn` inside a transaction that holds an exclusive advisory lock for a
 * single resource.
 *
 * ## Why an advisory lock and not `SELECT ... FOR UPDATE`?
 *
 * The thing we need to protect is the *absence* of rows in a time range. Row
 * locks can only lock rows that exist, so two transactions can both read "no
 * conflicts" and both insert. Options:
 *
 * 1. `SELECT ... FOR UPDATE` on the parent `resources` row — works, but
 *    serialises every booking for the resource behind a lock on a row that also
 *    gets read by ordinary queries, and holds it for the whole transaction.
 * 2. `SERIALIZABLE` isolation — correct, but predicate conflicts surface as
 *    40001 retry errors that the caller must loop on.
 * 3. A transaction-scoped advisory lock keyed on the resource id — chosen.
 *    It is precise (bookings for *different* resources never block each other),
 *    needs no retry loop, and is released automatically on COMMIT/ROLLBACK
 *    even if the process dies.
 *
 * The lock makes conflicts *rare*; the `bookings_no_overlap` exclusion
 * constraint makes double-booking *impossible*. Belt and braces — the DB is
 * the source of truth, the lock just gives us clean error messages instead of
 * constraint violations.
 */
async function withResourceLock<T>(
	prisma: PrismaClient,
	resourceId: string,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	try {
		return await prisma.$transaction(
			async (tx) => {
				// hashtextextended() gives a stable bigint from the uuid text.
				// The two-argument form of pg_advisory_xact_lock namespaces the key.
				// ::text because pg_advisory_xact_lock returns void, which Prisma's
				// $queryRaw deserializer rejects.
				await tx.$queryRaw`
					SELECT pg_advisory_xact_lock(
						${LOCK_NAMESPACE}::int,
						(hashtextextended(${resourceId}::text, 0) % 2147483647)::int
					)::text AS locked
				`
				return await fn(tx)
			},
			{
				maxWait: 10_000,
				timeout: 15_000,
				isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
			},
		)
	} catch (error) {
		throw translateDatabaseError(error)
	}
}

/**
 * Confirmed bookings on `resourceId` overlapping `[startTime, endTime)`.
 *
 * Two details carry all the weight:
 *  - `status: CONFIRMED` — cancelled bookings are invisible here, which is
 *    exactly what "cancelled slots are reusable" means.
 *  - `startTime < end AND endTime > start` with *strict* comparisons — the
 *    half-open overlap test. A booking that ends exactly when ours starts is
 *    not a conflict.
 */
async function findConfirmedConflicts(
	tx: Tx,
	args: {
		resourceId: string
		interval: Interval
		excludeBookingId?: string
	},
): Promise<Booking[]> {
	return tx.booking.findMany({
		where: {
			resourceId: args.resourceId,
			status: "CONFIRMED",
			startTime: { lt: args.interval.endTime },
			endTime: { gt: args.interval.startTime },
			...(args.excludeBookingId ? { id: { not: args.excludeBookingId } } : {}),
		},
		orderBy: { startTime: "asc" },
	})
}

function cleanTitle(title: string): string {
	const trimmed = title.trim()
	if (trimmed.length === 0) {
		throw badUserInput('"title" must not be empty.', { field: "title" })
	}
	if (trimmed.length > 200) {
		throw badUserInput('"title" may not exceed 200 characters.', {
			field: "title",
		})
	}
	return trimmed
}

function conflictError(conflicts: readonly Booking[]): never {
	const summary = conflicts
		.slice(0, 3)
		.map(
			(c) => `"${c.title}" (${c.startTime.toISOString()} – ${c.endTime.toISOString()})`,
		)
		.join(", ")

	throw bookingConflict(
		`The requested window overlaps ${conflicts.length} confirmed booking(s) on this resource: ${summary}.`,
		conflicts.map((c) => c.id),
	)
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export async function createResource(
	prisma: PrismaClient,
	input: { name: string; capacity: number },
): Promise<{ id: string; name: string; capacity: number; createdAt: Date }> {
	const name = input.name.trim()
	if (name.length === 0) {
		throw badUserInput('"name" must not be empty.', { field: "name" })
	}
	if (name.length > 120) {
		throw badUserInput('"name" may not exceed 120 characters.', {
			field: "name",
		})
	}
	if (!Number.isInteger(input.capacity) || input.capacity <= 0) {
		throw badUserInput('"capacity" must be a positive integer.', {
			field: "capacity",
		})
	}

	try {
		return await prisma.resource.create({
			data: { name, capacity: input.capacity },
		})
	} catch (error) {
		throw translateDatabaseError(error)
	}
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export async function createBooking(
	prisma: PrismaClient,
	input: {
		resourceId: string
		title: string
		startTime: Date
		endTime: Date
	},
): Promise<Booking> {
	assertUuid(input.resourceId, "resourceId")
	const interval: Interval = {
		startTime: input.startTime,
		endTime: input.endTime,
	}
	assertValidBookingInterval(interval)
	const title = cleanTitle(input.title)

	return withResourceLock(prisma, input.resourceId, async (tx) => {
		const resource = await tx.resource.findUnique({
			where: { id: input.resourceId },
			select: { id: true },
		})
		if (!resource) throw notFound("Resource", input.resourceId)

		const conflicts = await findConfirmedConflicts(tx, {
			resourceId: input.resourceId,
			interval,
		})
		if (conflicts.length > 0) conflictError(conflicts)

		return tx.booking.create({
			data: {
				resourceId: input.resourceId,
				title,
				startTime: interval.startTime,
				endTime: interval.endTime,
				status: "CONFIRMED",
			},
		})
	})
}

/**
 * Move an existing booking.
 *
 * The conflict check is identical to `createBooking`'s except for
 * `excludeBookingId`. Without that exclusion a booking would always collide
 * with its own current row whenever the new window overlaps the old one (e.g.
 * extending 10:00–11:00 to 10:00–12:00), which is the classic reschedule bug.
 */
export async function rescheduleBooking(
	prisma: PrismaClient,
	input: { id: string; startTime: Date; endTime: Date },
): Promise<Booking> {
	assertUuid(input.id, "id")
	const interval: Interval = {
		startTime: input.startTime,
		endTime: input.endTime,
	}
	assertValidBookingInterval(interval)

	// Read once outside the lock purely to learn which resource to lock.
	// Everything is re-read inside the transaction, so this value is never trusted.
	const existing = await prisma.booking.findUnique({
		where: { id: input.id },
		select: { resourceId: true },
	})
	if (!existing) throw notFound("Booking", input.id)

	return withResourceLock(prisma, existing.resourceId, async (tx) => {
		const booking = await tx.booking.findUnique({ where: { id: input.id } })
		if (!booking) throw notFound("Booking", input.id)

		if (booking.status === "CANCELLED") {
			throw badUserInput(
				"A cancelled booking cannot be rescheduled. Create a new booking instead.",
				{ bookingId: booking.id, status: booking.status },
			)
		}

		// Guard against the resource having changed under us (it cannot today,
		// but this keeps the lock honest if a `moveBooking` mutation is added).
		if (booking.resourceId !== existing.resourceId) {
			throw bookingConflict(
				"The booking moved to a different resource while it was being rescheduled. Please retry.",
			)
		}

		const conflicts = await findConfirmedConflicts(tx, {
			resourceId: booking.resourceId,
			interval,
			excludeBookingId: booking.id,
		})
		if (conflicts.length > 0) conflictError(conflicts)

		return tx.booking.update({
			where: { id: booking.id },
			data: { startTime: interval.startTime, endTime: interval.endTime },
		})
	})
}

/**
 * Cancel a booking. Idempotent: cancelling an already-cancelled booking
 * returns it unchanged rather than erroring, so retries are safe.
 */
export async function cancelBooking(
	prisma: PrismaClient,
	id: string,
): Promise<Booking> {
	assertUuid(id, "id")

	const booking = await prisma.booking.findUnique({ where: { id } })
	if (!booking) throw notFound("Booking", id)
	if (booking.status === "CANCELLED") return booking

	try {
		return await prisma.booking.update({
			where: { id },
			data: { status: "CANCELLED" },
		})
	} catch (error) {
		throw translateDatabaseError(error)
	}
}

export async function deleteBooking(
	prisma: PrismaClient,
	id: string,
): Promise<{ id: string; deleted: boolean }> {
	assertUuid(id, "id")

	try {
		await prisma.booking.delete({ where: { id } })
		return { id, deleted: true }
	} catch (error) {
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2025"
		) {
			throw notFound("Booking", id)
		}
		throw translateDatabaseError(error)
	}
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type AvailabilityResult = {
	resourceId: string
	from: Date
	to: Date
	isAvailable: boolean
	conflicts: Booking[]
	freeSlots: Interval[]
}

export async function getAvailability(
	prisma: PrismaClient,
	args: { resourceId: string; from: Date; to: Date },
): Promise<AvailabilityResult> {
	assertUuid(args.resourceId, "resourceId")
	const window: Interval = { startTime: args.from, endTime: args.to }
	assertValidAvailabilityWindow(window)

	const resource = await prisma.resource.findUnique({
		where: { id: args.resourceId },
		select: { id: true },
	})
	if (!resource) throw notFound("Resource", args.resourceId)

	const conflicts = await prisma.booking.findMany({
		where: {
			resourceId: args.resourceId,
			status: "CONFIRMED",
			startTime: { lt: window.endTime },
			endTime: { gt: window.startTime },
		},
		orderBy: { startTime: "asc" },
	})

	return {
		resourceId: args.resourceId,
		from: args.from,
		to: args.to,
		isAvailable: conflicts.length === 0,
		conflicts,
		freeSlots: computeFreeSlots(window, conflicts),
	}
}
