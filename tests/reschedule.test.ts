import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { prisma } from "../src/prisma.ts"
import {
	CANCEL_BOOKING,
	RESCHEDULE_BOOKING,
	at,
	bookConfirmed,
	errorCodes,
	gql,
	gqlOk,
	makeResource,
	resetDatabase,
} from "./helpers.ts"

beforeEach(resetDatabase)
afterAll(async () => {
	await prisma.$disconnect()
})

describe("rescheduleBooking", () => {
	test("moves a booking into a free window", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Moves", at(10), at(11))

		const data = await gqlOk<{
			rescheduleBooking: { startTime: string; endTime: string }
		}>(RESCHEDULE_BOOKING, {
			input: { id, startTime: at(14), endTime: at(15) },
		})

		expect(data.rescheduleBooking.startTime).toBe(at(14))
		expect(data.rescheduleBooking.endTime).toBe(at(15))
	})

	// This is the case that fails if the conflict query forgets `id != self`.
	test("a booking never conflicts with itself when extended", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Extends", at(10), at(11))

		const data = await gqlOk<{ rescheduleBooking: { endTime: string } }>(
			RESCHEDULE_BOOKING,
			{ input: { id, startTime: at(10), endTime: at(12) } },
		)
		expect(data.rescheduleBooking.endTime).toBe(at(12))
	})

	test("a booking never conflicts with itself when shifted slightly", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Shifts", at(10), at(11))

		const data = await gqlOk<{ rescheduleBooking: { startTime: string } }>(
			RESCHEDULE_BOOKING,
			{ input: { id, startTime: at(10, 30), endTime: at(11, 30) } },
		)
		expect(data.rescheduleBooking.startTime).toBe(at(10, 30))
	})

	test("rescheduling to the identical window is a no-op success", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Unchanged", at(10), at(11))

		const data = await gqlOk<{ rescheduleBooking: { startTime: string } }>(
			RESCHEDULE_BOOKING,
			{ input: { id, startTime: at(10), endTime: at(11) } },
		)
		expect(data.rescheduleBooking.startTime).toBe(at(10))
	})

	test("rejects a move onto another confirmed booking", async () => {
		const resourceId = await makeResource()
		const mover = await bookConfirmed(resourceId, "Mover", at(10), at(11))
		await bookConfirmed(resourceId, "Blocker", at(14), at(15))

		const result = await gql(RESCHEDULE_BOOKING, {
			input: { id: mover, startTime: at(14, 30), endTime: at(15, 30) },
		})

		expect(errorCodes(result)).toEqual(["BOOKING_CONFLICT"])

		// The original window must be untouched after a failed reschedule.
		const unchanged = await prisma.booking.findUniqueOrThrow({
			where: { id: mover },
		})
		expect(unchanged.startTime.toISOString()).toBe(at(10))
		expect(unchanged.endTime.toISOString()).toBe(at(11))
	})

	test("allows a move that lands exactly back-to-back with a neighbour", async () => {
		const resourceId = await makeResource()
		const mover = await bookConfirmed(resourceId, "Mover", at(10), at(11))
		await bookConfirmed(resourceId, "Neighbour", at(14), at(15))

		const data = await gqlOk<{ rescheduleBooking: { endTime: string } }>(
			RESCHEDULE_BOOKING,
			{ input: { id: mover, startTime: at(13), endTime: at(14) } },
		)
		expect(data.rescheduleBooking.endTime).toBe(at(14))
	})

	test("ignores cancelled bookings when checking conflicts", async () => {
		const resourceId = await makeResource()
		const blocker = await bookConfirmed(resourceId, "Blocker", at(14), at(15))
		const mover = await bookConfirmed(resourceId, "Mover", at(10), at(11))

		await gqlOk(CANCEL_BOOKING, { id: blocker })

		const data = await gqlOk<{ rescheduleBooking: { startTime: string } }>(
			RESCHEDULE_BOOKING,
			{ input: { id: mover, startTime: at(14), endTime: at(15) } },
		)
		expect(data.rescheduleBooking.startTime).toBe(at(14))
	})

	test("refuses to reschedule a cancelled booking", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Cancelled", at(10), at(11))
		await gqlOk(CANCEL_BOOKING, { id })

		const result = await gql(RESCHEDULE_BOOKING, {
			input: { id, startTime: at(16), endTime: at(17) },
		})
		expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"])
	})

	test("validates the new window", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Valid", at(10), at(11))

		const result = await gql(RESCHEDULE_BOOKING, {
			input: { id, startTime: at(12), endTime: at(11) },
		})
		expect(errorCodes(result)).toEqual(["BAD_USER_INPUT"])
	})

	test("reports NOT_FOUND for an unknown booking", async () => {
		const result = await gql(RESCHEDULE_BOOKING, {
			input: { id: crypto.randomUUID(), startTime: at(10), endTime: at(11) },
		})
		expect(errorCodes(result)).toEqual(["NOT_FOUND"])
	})

	test("updatedAt advances but createdAt does not", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Timestamped", at(10), at(11))
		const before = await prisma.booking.findUniqueOrThrow({ where: { id } })

		await Bun.sleep(5)
		await gqlOk(RESCHEDULE_BOOKING, {
			input: { id, startTime: at(16), endTime: at(17) },
		})

		const after = await prisma.booking.findUniqueOrThrow({ where: { id } })
		expect(after.createdAt.getTime()).toBe(before.createdAt.getTime())
		expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime())
	})
})
