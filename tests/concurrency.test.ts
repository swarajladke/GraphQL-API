import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { prisma } from "../src/prisma.ts"
import {
	CREATE_BOOKING,
	RESCHEDULE_BOOKING,
	at,
	bookConfirmed,
	gql,
	makeResource,
	resetDatabase,
} from "./helpers.ts"

beforeEach(resetDatabase)
afterAll(async () => {
	await prisma.$disconnect()
})

/**
 * These are the tests that actually justify the locking strategy.
 *
 * A naive "SELECT conflicts, then INSERT" implementation passes every other
 * test file in this suite and still double-books here, because all N requests
 * run their SELECT before any of them COMMITs.
 */
describe("concurrent booking attempts", () => {
	test("20 simultaneous requests for the same slot → exactly one wins", async () => {
		const resourceId = await makeResource()
		const ATTEMPTS = 20

		const results = await Promise.all(
			Array.from({ length: ATTEMPTS }, (_unused, i) =>
				gql(CREATE_BOOKING, {
					input: {
						resourceId,
						title: `Racer ${i}`,
						startTime: at(10),
						endTime: at(11),
					},
				}),
			),
		)

		const succeeded = results.filter((r) => !r.errors?.length)
		const failed = results.filter((r) => r.errors?.length)

		expect(succeeded).toHaveLength(1)
		expect(failed).toHaveLength(ATTEMPTS - 1)

		// Every loser got the domain error, not a leaked constraint violation.
		for (const failure of failed) {
			expect(failure.errors?.[0]?.extensions?.["code"]).toBe("BOOKING_CONFLICT")
		}

		expect(
			await prisma.booking.count({
				where: { resourceId, status: "CONFIRMED" },
			}),
		).toBe(1)
	})

	test("partially overlapping concurrent requests → no overlap survives", async () => {
		// Windows chained so each overlaps its neighbour by 30 minutes:
		// 10:00-11:00, 10:30-11:30, 11:00-12:00, 11:30-12:30, 12:00-13:00
		const resourceId = await makeResource()
		const windows: Array<[number, number]> = [
			[10, 11],
			[10.5, 11.5],
			[11, 12],
			[11.5, 12.5],
			[12, 13],
		]

		await Promise.all(
			windows.map(([start, end], i) =>
				gql(CREATE_BOOKING, {
					input: {
						resourceId,
						title: `Chain ${i}`,
						startTime: at(Math.floor(start), (start % 1) * 60),
						endTime: at(Math.floor(end), (end % 1) * 60),
					},
				}),
			),
		)

		const confirmed = await prisma.booking.findMany({
			where: { resourceId, status: "CONFIRMED" },
			orderBy: { startTime: "asc" },
		})

		// Whichever subset won, the survivors must be pairwise non-overlapping.
		for (let i = 1; i < confirmed.length; i++) {
			const previous = confirmed[i - 1]!
			const current = confirmed[i]!
			expect(current.startTime.getTime()).toBeGreaterThanOrEqual(
				previous.endTime.getTime(),
			)
		}
		expect(confirmed.length).toBeGreaterThanOrEqual(1)
	})

	test("concurrent back-to-back requests all succeed (no false conflicts)", async () => {
		// The lock must not be so coarse that legitimate adjacent bookings fail.
		const resourceId = await makeResource()
		const hours = [9, 10, 11, 12, 13, 14, 15, 16]

		const results = await Promise.all(
			hours.map((hour) =>
				gql(CREATE_BOOKING, {
					input: {
						resourceId,
						title: `Slot ${hour}`,
						startTime: at(hour),
						endTime: at(hour + 1),
					},
				}),
			),
		)

		expect(results.filter((r) => r.errors?.length)).toHaveLength(0)
		expect(await prisma.booking.count({ where: { resourceId } })).toBe(
			hours.length,
		)
	})

	test("bookings on different resources are not serialised against each other", async () => {
		// Locks are keyed per resource, so 10 rooms booking the same hour is fine.
		const resourceIds = await Promise.all(
			Array.from({ length: 10 }, (_unused, i) => makeResource(`Parallel ${i}`)),
		)

		const results = await Promise.all(
			resourceIds.map((resourceId) =>
				gql(CREATE_BOOKING, {
					input: {
						resourceId,
						title: "Same hour, different room",
						startTime: at(10),
						endTime: at(11),
					},
				}),
			),
		)

		expect(results.filter((r) => r.errors?.length)).toHaveLength(0)
		expect(await prisma.booking.count()).toBe(10)
	})

	test("concurrent reschedules onto the same free window → one wins", async () => {
		const resourceId = await makeResource()
		const a = await bookConfirmed(resourceId, "A", at(9), at(10))
		const b = await bookConfirmed(resourceId, "B", at(10), at(11))

		// Both try to grab the empty 15:00-16:00 slot at the same time.
		const results = await Promise.all([
			gql(RESCHEDULE_BOOKING, {
				input: { id: a, startTime: at(15), endTime: at(16) },
			}),
			gql(RESCHEDULE_BOOKING, {
				input: { id: b, startTime: at(15), endTime: at(16) },
			}),
		])

		expect(results.filter((r) => !r.errors?.length)).toHaveLength(1)
		expect(
			await prisma.booking.count({
				where: { resourceId, startTime: new Date(at(15)) },
			}),
		).toBe(1)
	})

	test("concurrent create + reschedule into the same window → one wins", async () => {
		const resourceId = await makeResource()
		const existing = await bookConfirmed(resourceId, "Existing", at(9), at(10))

		const [created, rescheduled] = await Promise.all([
			gql(CREATE_BOOKING, {
				input: {
					resourceId,
					title: "Newcomer",
					startTime: at(15),
					endTime: at(16),
				},
			}),
			gql(RESCHEDULE_BOOKING, {
				input: { id: existing, startTime: at(15), endTime: at(16) },
			}),
		])

		const winners = [created, rescheduled].filter((r) => !r.errors?.length)
		expect(winners).toHaveLength(1)
		expect(
			await prisma.booking.count({
				where: {
					resourceId,
					status: "CONFIRMED",
					startTime: new Date(at(15)),
				},
			}),
		).toBe(1)
	})

	test("concurrent cancel-then-rebook does not lose the slot", async () => {
		const resourceId = await makeResource()
		const original = await bookConfirmed(resourceId, "Original", at(10), at(11))

		await prisma.booking.update({
			where: { id: original },
			data: { status: "CANCELLED" },
		})

		// After cancellation, 5 racers compete for the freed slot: exactly one wins.
		const results = await Promise.all(
			Array.from({ length: 5 }, (_unused, i) =>
				gql(CREATE_BOOKING, {
					input: {
						resourceId,
						title: `Rebook ${i}`,
						startTime: at(10),
						endTime: at(11),
					},
				}),
			),
		)

		expect(results.filter((r) => !r.errors?.length)).toHaveLength(1)
	})
})
