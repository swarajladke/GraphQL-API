import { badUserInput } from "./errors.ts"

export const MS_PER_MINUTE = 60_000
export const MS_PER_HOUR = 60 * MS_PER_MINUTE
export const MS_PER_DAY = 24 * MS_PER_HOUR

/** A single booking may not exceed 24h. Longer reservations should be split. */
export const MAX_BOOKING_DURATION_MS = MS_PER_DAY
/** Availability windows are capped so a query can never scan the whole table. */
export const MAX_AVAILABILITY_WINDOW_MS = 90 * MS_PER_DAY
/** Timestamps are stored with millisecond precision (`timestamptz(3)`). */
export const TIME_PRECISION_MS = 1

/**
 * A closed-open interval `[start, end)`.
 *
 * This is THE core modelling decision of the service. Because the end bound is
 * exclusive, a booking 10:00–11:00 and a booking 11:00–12:00 share only the
 * instant 11:00, which belongs to the second booking alone — so back-to-back
 * bookings are legal by construction rather than by special-casing.
 */
export type Interval = {
	readonly startTime: Date
	readonly endTime: Date
}

/**
 * Do two half-open intervals overlap?
 *
 * `a.start < b.end && a.end > b.start`
 *
 * Note both comparisons are strict. Using `<=` / `>=` anywhere here is the
 * classic bug that forbids back-to-back bookings.
 */
export function overlaps(a: Interval, b: Interval): boolean {
	return (
		a.startTime.getTime() < b.endTime.getTime() &&
		a.endTime.getTime() > b.startTime.getTime()
	)
}

function assertRealDate(value: Date, field: string): void {
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw badUserInput(`"${field}" is not a valid date-time.`, { field })
	}
}

/** Validates a booking window before it ever reaches the database. */
export function assertValidBookingInterval(interval: Interval): void {
	assertRealDate(interval.startTime, "startTime")
	assertRealDate(interval.endTime, "endTime")

	const durationMs = interval.endTime.getTime() - interval.startTime.getTime()

	if (durationMs <= 0) {
		throw badUserInput(
			"\"endTime\" must be strictly after \"startTime\" (bookings are half-open intervals [startTime, endTime), so a zero-length booking is meaningless).",
			{ field: "endTime" },
		)
	}

	if (durationMs < TIME_PRECISION_MS) {
		throw badUserInput(
			"Booking duration must be at least 1 millisecond.",
			{ field: "endTime" },
		)
	}

	if (durationMs > MAX_BOOKING_DURATION_MS) {
		throw badUserInput(
			`A single booking may not exceed ${MAX_BOOKING_DURATION_MS / MS_PER_HOUR} hours. Split it into multiple bookings.`,
			{ field: "endTime", maxDurationMs: MAX_BOOKING_DURATION_MS },
		)
	}
}

/** Validates an availability query window (allowed to be much longer). */
export function assertValidAvailabilityWindow(interval: Interval): void {
	assertRealDate(interval.startTime, "from")
	assertRealDate(interval.endTime, "to")

	const durationMs = interval.endTime.getTime() - interval.startTime.getTime()

	if (durationMs <= 0) {
		throw badUserInput('"to" must be strictly after "from".', { field: "to" })
	}

	if (durationMs > MAX_AVAILABILITY_WINDOW_MS) {
		throw badUserInput(
			`Availability windows are limited to ${MAX_AVAILABILITY_WINDOW_MS / MS_PER_DAY} days.`,
			{ field: "to", maxWindowMs: MAX_AVAILABILITY_WINDOW_MS },
		)
	}
}

/**
 * Given the confirmed bookings overlapping `window`, return the gaps that are
 * still bookable, clipped to the window.
 *
 * `busy` does not need to be sorted or disjoint — overlapping input is merged
 * defensively so the function stays correct even if it is ever fed the result
 * of a wider query.
 */
export function computeFreeSlots(
	window: Interval,
	busy: readonly Interval[],
): Interval[] {
	const windowStart = window.startTime.getTime()
	const windowEnd = window.endTime.getTime()
	if (windowEnd <= windowStart) return []

	const clipped = busy
		.map((b) => ({
			start: Math.max(b.startTime.getTime(), windowStart),
			end: Math.min(b.endTime.getTime(), windowEnd),
		}))
		.filter((b) => b.end > b.start)
		.sort((a, b) => a.start - b.start)

	const free: Interval[] = []
	let cursor = windowStart

	for (const block of clipped) {
		if (block.start > cursor) {
			free.push({
				startTime: new Date(cursor),
				endTime: new Date(block.start),
			})
		}
		cursor = Math.max(cursor, block.end)
	}

	if (cursor < windowEnd) {
		free.push({ startTime: new Date(cursor), endTime: new Date(windowEnd) })
	}

	return free
}
