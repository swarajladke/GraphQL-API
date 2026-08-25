import { Prisma } from "@prisma/client"
import { alreadyExists, bookingConflict } from "./errors.ts"

/** Postgres SQLSTATE for `exclusion_violation`. */
const SQLSTATE_EXCLUSION_VIOLATION = "23P01"
const NO_OVERLAP_CONSTRAINT = "bookings_no_overlap"
const END_AFTER_START_CONSTRAINT = "bookings_end_after_start"

function describes(error: unknown, needle: string): boolean {
	if (!(error instanceof Error)) return false
	const meta = (error as { meta?: Record<string, unknown> }).meta
	const metaText = meta ? JSON.stringify(meta) : ""
	return error.message.includes(needle) || metaText.includes(needle)
}

/**
 * Translate database-level integrity failures into domain GraphQL errors.
 *
 * The exclusion constraint is the last line of defence: if two transactions
 * slip past the advisory lock for any reason, Postgres rejects the loser with
 * SQLSTATE 23P01 and we surface the same BOOKING_CONFLICT the application-level
 * check would have produced. Clients cannot tell the difference — which is the
 * point.
 *
 * Anything we do not recognise is rethrown untouched.
 */
export function translateDatabaseError(error: unknown): unknown {
	const isExclusion =
		describes(error, SQLSTATE_EXCLUSION_VIOLATION) ||
		describes(error, NO_OVERLAP_CONSTRAINT)

	if (isExclusion) {
		return bookingConflict(
			"This time slot was just taken by another confirmed booking for the same resource. Please pick a different window.",
		)
	}

	if (describes(error, END_AFTER_START_CONSTRAINT)) {
		return bookingConflict('"endTime" must be strictly after "startTime".')
	}

	if (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		error.code === "P2002"
	) {
		const target = error.meta?.["target"]
		const fields = Array.isArray(target) ? target.join(", ") : String(target)
		return alreadyExists(`A record with the same ${fields} already exists.`)
	}

	return error
}
