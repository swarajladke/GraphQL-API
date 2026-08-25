import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { prisma } from "../src/prisma.ts"
import {
	AVAILABILITY,
	CREATE_RESOURCE,
	at,
	bookConfirmed,
	errorCodes,
	gql,
	gqlOk,
	makeResource,
	resetDatabase,
} from "./helpers.ts"
import { computeFreeSlots, overlaps } from "../src/lib/time.ts"

beforeEach(resetDatabase)
afterAll(async () => {
	await prisma.$disconnect()
})

type AvailabilityResult = {
	availability: {
		isAvailable: boolean
		conflicts: Array<{ id: string; title: string }>
		freeSlots: Array<{ startTime: string; endTime: string }>
	}
}

describe("availability query", () => {
	test("an empty resource is fully available", async () => {
		const resourceId = await makeResource()

		const data = await gqlOk<AvailabilityResult>(AVAILABILITY, {
			resourceId,
			from: at(9),
			to: at(17),
		})

		expect(data.availability.isAvailable).toBe(true)
		expect(data.availability.conflicts).toHaveLength(0)
		expect(data.availability.freeSlots).toEqual([
			{ startTime: at(9), endTime: at(17) },
		])
	})

	test("reports the gaps between bookings", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "Morning", at(10), at(11))
		await bookConfirmed(resourceId, "Afternoon", at(14), at(15))

		const data = await gqlOk<AvailabilityResult>(AVAILABILITY, {
			resourceId,
			from: at(9),
			to: at(17),
		})

		expect(data.availability.isAvailable).toBe(false)
		expect(data.availability.conflicts.map((c) => c.title)).toEqual([
			"Morning",
			"Afternoon",
		])
		expect(data.availability.freeSlots).toEqual([
			{ startTime: at(9), endTime: at(10) },
			{ startTime: at(11), endTime: at(14) },
			{ startTime: at(15), endTime: at(17) },
		])
	})

	test("back-to-back bookings leave no phantom gap", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "10-11", at(10), at(11))
		await bookConfirmed(resourceId, "11-12", at(11), at(12))

		const data = await gqlOk<AvailabilityResult>(AVAILABILITY, {
			resourceId,
			from: at(10),
			to: at(12),
		})

		expect(data.availability.freeSlots).toEqual([])
	})

	test("a booking touching the window edge is not a conflict", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "Ends at window start", at(9), at(10))
		await bookConfirmed(resourceId, "Starts at window end", at(11), at(12))

		const data = await gqlOk<AvailabilityResult>(AVAILABILITY, {
			resourceId,
			from: at(10),
			to: at(11),
		})

		expect(data.availability.isAvailable).toBe(true)
		expect(data.availability.conflicts).toHaveLength(0)
	})

	test("clips bookings that extend past the window", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "Spans window", at(8), at(16))

		const data = await gqlOk<AvailabilityResult>(AVAILABILITY, {
			resourceId,
			from: at(10),
			to: at(12),
		})

		expect(data.availability.isAvailable).toBe(false)
		expect(data.availability.freeSlots).toEqual([])
	})

	test("validates the window and the resource", async () => {
		const resourceId = await makeResource()

		const reversed = await gql(AVAILABILITY, {
			resourceId,
			from: at(12),
			to: at(10),
		})
		expect(errorCodes(reversed)).toEqual(["BAD_USER_INPUT"])

		const missing = await gql(AVAILABILITY, {
			resourceId: crypto.randomUUID(),
			from: at(10),
			to: at(12),
		})
		expect(errorCodes(missing)).toEqual(["NOT_FOUND"])
	})
})

describe("createResource", () => {
	test("creates a resource with a generated id and createdAt", async () => {
		const data = await gqlOk<{
			createResource: {
				id: string
				name: string
				capacity: number
				createdAt: string
			}
		}>(CREATE_RESOURCE, { input: { name: "Boardroom", capacity: 12 } })

		expect(data.createResource.id).toMatch(/^[0-9a-f-]{36}$/)
		expect(data.createResource.name).toBe("Boardroom")
		expect(data.createResource.capacity).toBe(12)
		expect(Number.isNaN(Date.parse(data.createResource.createdAt))).toBe(false)
	})

	test("rejects a non-positive capacity and a blank name", async () => {
		const badCapacity = await gql(CREATE_RESOURCE, {
			input: { name: "Zero", capacity: 0 },
		})
		expect(errorCodes(badCapacity)).toEqual(["BAD_USER_INPUT"])

		const blankName = await gql(CREATE_RESOURCE, {
			input: { name: "   ", capacity: 4 },
		})
		expect(errorCodes(blankName)).toEqual(["BAD_USER_INPUT"])
	})

	test("rejects a duplicate name", async () => {
		await gqlOk(CREATE_RESOURCE, { input: { name: "Unique", capacity: 4 } })
		const duplicate = await gql(CREATE_RESOURCE, {
			input: { name: "Unique", capacity: 4 },
		})
		expect(errorCodes(duplicate)).toEqual(["CONFLICT"])
	})
})

// Pure-function coverage for the interval maths, kept alongside the DB tests so
// a failure immediately tells you whether the bug is in the logic or the SQL.
describe("interval helpers", () => {
	const iv = (startHour: number, endHour: number) => ({
		startTime: new Date(at(startHour)),
		endTime: new Date(at(endHour)),
	})

	test("overlaps() is false for back-to-back intervals", () => {
		expect(overlaps(iv(10, 11), iv(11, 12))).toBe(false)
		expect(overlaps(iv(11, 12), iv(10, 11))).toBe(false)
	})

	test("overlaps() is true for any shared instant", () => {
		expect(overlaps(iv(10, 12), iv(11, 13))).toBe(true)
		expect(overlaps(iv(10, 12), iv(10.5, 11))).toBe(true)
		expect(overlaps(iv(10.5, 11), iv(10, 12))).toBe(true)
	})

	test("computeFreeSlots() merges overlapping busy blocks", () => {
		expect(computeFreeSlots(iv(9, 17), [iv(10, 12), iv(11, 13)])).toEqual([
			iv(9, 10),
			iv(13, 17),
		])
	})

	test("computeFreeSlots() handles a fully-booked window", () => {
		expect(computeFreeSlots(iv(9, 17), [iv(8, 18)])).toEqual([])
	})

	test("computeFreeSlots() tolerates unsorted input", () => {
		expect(computeFreeSlots(iv(9, 17), [iv(14, 15), iv(10, 11)])).toEqual([
			iv(9, 10),
			iv(11, 14),
			iv(15, 17),
		])
	})
})
