import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { prisma } from "../src/prisma.ts"
import {
	CREATE_BOOKING,
	at,
	bookConfirmed,
	errorCodes,
	gql,
	makeResource,
	resetDatabase,
} from "./helpers.ts"

beforeEach(resetDatabase)
afterAll(async () => {
	await prisma.$disconnect()
})

describe("overlap rejection", () => {
	test("rejects an identical window", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "Standup", at(10), at(11))

		const result = await gql(CREATE_BOOKING, {
			input: {
				resourceId,
				title: "Duplicate",
				startTime: at(10),
				endTime: at(11),
			},
		})

		expect(errorCodes(result)).toEqual(["BOOKING_CONFLICT"])
		expect(await prisma.booking.count()).toBe(1)
	})

	// Every geometric relationship between two intervals, so a subtly wrong
	// comparison operator cannot pass by luck.
	const overlapping: Array<[string, number, number]> = [
		["starts before, ends inside", 9, 10.5],
		["starts inside, ends after", 10.5, 12],
		["fully contained", 10.25, 10.75],
		["fully containing", 9, 12],
		["same start, shorter", 10, 10.5],
		["same start, longer", 10, 11.5],
		["same end, later start", 10.5, 11],
		["same end, earlier start", 9.5, 11],
	]

	test.each(overlapping)(
		"rejects overlap: %s",
		async (_label, startHour, endHour) => {
			const resourceId = await makeResource()
			await bookConfirmed(resourceId, "Existing 10:00-11:00", at(10), at(11))

			const result = await gql(CREATE_BOOKING, {
				input: {
					resourceId,
					title: "Attempt",
					startTime: at(Math.floor(startHour), (startHour % 1) * 60),
					endTime: at(Math.floor(endHour), (endHour % 1) * 60),
				},
			})

			expect(errorCodes(result)).toEqual(["BOOKING_CONFLICT"])
			expect(await prisma.booking.count()).toBe(1)
		},
	)

	test("the same window on a DIFFERENT resource is fine", async () => {
		const roomA = await makeResource("Room A")
		const roomB = await makeResource("Room B")

		await bookConfirmed(roomA, "A 10-11", at(10), at(11))
		await bookConfirmed(roomB, "B 10-11", at(10), at(11))

		expect(await prisma.booking.count()).toBe(2)
	})

	test("the exclusion constraint blocks a raw SQL overlap too", async () => {
		// Bypasses every application-level check. If this insert succeeded, the
		// "can never overlap" guarantee would only be a convention.
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "Existing", at(10), at(11))

		// Wrapped in an async fn so we get a native Promise: Prisma returns a
		// PrismaPromise thenable, which bun:test's `.rejects` does not accept.
		const insertOverlapping = async (): Promise<number> =>
			prisma.$executeRawUnsafe(
				`INSERT INTO "bookings" ("resource_id", "title", "start_time", "end_time", "status", "updated_at")
				 VALUES ($1::uuid, 'Sneaky', $2::timestamptz, $3::timestamptz, 'CONFIRMED', now())`,
				resourceId,
				at(10, 30),
				at(11, 30),
			)

		await expect(insertOverlapping()).rejects.toThrow(
			/bookings_no_overlap|exclusion/i,
		)

		expect(await prisma.booking.count()).toBe(1)
	})
})

describe("back-to-back bookings (half-open intervals)", () => {
	test("allows a booking that starts exactly when another ends", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "09:00-10:00", at(9), at(10))
		await bookConfirmed(resourceId, "10:00-11:00", at(10), at(11))
		await bookConfirmed(resourceId, "11:00-12:00", at(11), at(12))

		expect(await prisma.booking.count()).toBe(3)
	})

	test("allows filling a gap exactly", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "09:00-10:00", at(9), at(10))
		await bookConfirmed(resourceId, "11:00-12:00", at(11), at(12))

		// Exactly the 10:00-11:00 hole: touches both neighbours, overlaps neither.
		await bookConfirmed(resourceId, "10:00-11:00", at(10), at(11))

		expect(await prisma.booking.count()).toBe(3)
	})

	test("one millisecond of overlap is still a conflict", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "10:00-11:00", at(10), at(11))

		const justBefore = new Date(
			new Date(at(11)).getTime() - 1,
		).toISOString()

		const result = await gql(CREATE_BOOKING, {
			input: {
				resourceId,
				title: "Overlaps by 1ms",
				startTime: justBefore,
				endTime: at(12),
			},
		})

		expect(errorCodes(result)).toEqual(["BOOKING_CONFLICT"])
	})
})

describe("input validation", () => {
	test("rejects endTime equal to startTime", async () => {
		const resourceId = await makeResource()
		const result = await gql(CREATE_BOOKING, {
			input: {
				resourceId,
				title: "Zero length",
				startTime: at(10),
				endTime: at(10),
			},
		})
		expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"])
	})

	test("rejects endTime before startTime", async () => {
		const resourceId = await makeResource()
		const result = await gql(CREATE_BOOKING, {
			input: {
				resourceId,
				title: "Reversed",
				startTime: at(11),
				endTime: at(10),
			},
		})
		expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"])
	})

	test("rejects a timestamp without a UTC offset", async () => {
		const resourceId = await makeResource()
		const result = await gql(CREATE_BOOKING, {
			input: {
				resourceId,
				title: "Ambiguous",
				startTime: "2026-09-01T10:00:00",
				endTime: "2026-09-01T11:00:00",
			},
		})
		expect(result.errors?.length).toBeGreaterThan(0)
	})

	test("reports NOT_FOUND for an unknown resource", async () => {
		const result = await gql(CREATE_BOOKING, {
			input: {
				resourceId: crypto.randomUUID(),
				title: "Ghost room",
				startTime: at(10),
				endTime: at(11),
			},
		})
		expect(errorCodes(result)).toEqual(["NOT_FOUND"])
	})

	test("rejects a non-UUID resource id without leaking SQL", async () => {
		const result = await gql(CREATE_BOOKING, {
			input: {
				resourceId: "not-a-uuid",
				title: "Bad id",
				startTime: at(10),
				endTime: at(11),
			},
		})
		expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"])
	})
})
