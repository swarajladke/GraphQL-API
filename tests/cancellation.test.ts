import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { prisma } from "../src/prisma.ts"
import {
	AVAILABILITY,
	CANCEL_BOOKING,
	CREATE_BOOKING,
	DELETE_BOOKING,
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

describe("cancelled bookings free their slot", () => {
	test("the exact same window can be re-booked after cancellation", async () => {
		const resourceId = await makeResource()
		const first = await bookConfirmed(resourceId, "Original", at(10), at(11))

		// Sanity: while confirmed, the slot is blocked.
		const blocked = await gql(CREATE_BOOKING, {
			input: { resourceId, title: "Too early", startTime: at(10), endTime: at(11) },
		})
		expect(errorCodes(blocked)).toEqual(["BOOKING_CONFLICT"])

		await gqlOk(CANCEL_BOOKING, { id: first })

		const second = await bookConfirmed(resourceId, "Replacement", at(10), at(11))
		expect(second).not.toBe(first)

		// The cancelled row is retained for history — nothing is destroyed.
		expect(await prisma.booking.count()).toBe(2)
		expect(await prisma.booking.count({ where: { status: "CONFIRMED" } })).toBe(1)
	})

	test("many cancelled bookings can stack on the same window", async () => {
		// The exclusion constraint is partial (WHERE status = 'CONFIRMED'), so
		// cancelled rows are simply not in the index.
		const resourceId = await makeResource()

		for (let i = 0; i < 5; i++) {
			const id = await bookConfirmed(resourceId, `Attempt ${i}`, at(10), at(11))
			await gqlOk(CANCEL_BOOKING, { id })
		}

		expect(await prisma.booking.count({ where: { status: "CANCELLED" } })).toBe(5)

		await bookConfirmed(resourceId, "Finally confirmed", at(10), at(11))
		expect(await prisma.booking.count({ where: { status: "CONFIRMED" } })).toBe(1)
	})

	test("cancelled bookings do not appear in availability conflicts", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Cancelled soon", at(10), at(11))

		const before = await gqlOk<{
			availability: { isAvailable: boolean; conflicts: unknown[] }
		}>(AVAILABILITY, { resourceId, from: at(9), to: at(12) })
		expect(before.availability.isAvailable).toBe(false)
		expect(before.availability.conflicts).toHaveLength(1)

		await gqlOk(CANCEL_BOOKING, { id })

		const after = await gqlOk<{
			availability: {
				isAvailable: boolean
				conflicts: unknown[]
				freeSlots: Array<{ startTime: string; endTime: string }>
			}
		}>(AVAILABILITY, { resourceId, from: at(9), to: at(12) })

		expect(after.availability.isAvailable).toBe(true)
		expect(after.availability.conflicts).toHaveLength(0)
		expect(after.availability.freeSlots).toEqual([
			{ startTime: at(9), endTime: at(12) },
		])
	})

	test("cancelling is idempotent", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Twice cancelled", at(10), at(11))

		const first = await gqlOk<{ cancelBooking: { status: string } }>(
			CANCEL_BOOKING,
			{ id },
		)
		const second = await gqlOk<{ cancelBooking: { status: string } }>(
			CANCEL_BOOKING,
			{ id },
		)

		expect(first.cancelBooking.status).toBe("CANCELLED")
		expect(second.cancelBooking.status).toBe("CANCELLED")
	})

	test("cancelling an unknown booking is NOT_FOUND", async () => {
		const result = await gql(CANCEL_BOOKING, { id: crypto.randomUUID() })
		expect(errorCodes(result)).toEqual(["NOT_FOUND"])
	})
})

describe("deleteBooking", () => {
	test("hard-deletes the row and frees the slot", async () => {
		const resourceId = await makeResource()
		const id = await bookConfirmed(resourceId, "Doomed", at(10), at(11))

		const data = await gqlOk<{ deleteBooking: { id: string; deleted: boolean } }>(
			DELETE_BOOKING,
			{ id },
		)
		expect(data.deleteBooking).toEqual({ id, deleted: true })
		expect(await prisma.booking.count()).toBe(0)

		await bookConfirmed(resourceId, "Reused slot", at(10), at(11))
		expect(await prisma.booking.count()).toBe(1)
	})

	test("deleting a missing booking is NOT_FOUND", async () => {
		const result = await gql(DELETE_BOOKING, { id: crypto.randomUUID() })
		expect(errorCodes(result)).toEqual(["NOT_FOUND"])
	})

	test("deleting a resource cascades to its bookings", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "Attached", at(10), at(11))

		await prisma.resource.delete({ where: { id: resourceId } })
		expect(await prisma.booking.count()).toBe(0)
	})
})
