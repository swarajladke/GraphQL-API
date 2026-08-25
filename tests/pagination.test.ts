import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { prisma } from "../src/prisma.ts"
import {
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

const BOOKINGS_PAGE = /* GraphQL */ `
	query Bookings($filter: BookingFilter, $first: Int, $after: String) {
		bookings(filter: $filter, first: $first, after: $after) {
			totalCount
			edges {
				cursor
				node {
					id
					title
					startTime
					status
				}
			}
			pageInfo {
				hasNextPage
				hasPreviousPage
				startCursor
				endCursor
			}
		}
	}
`

type BookingsPage = {
	bookings: {
		totalCount: number
		edges: Array<{ cursor: string; node: { id: string; title: string; startTime: string; status: string } }>
		pageInfo: {
			hasNextPage: boolean
			hasPreviousPage: boolean
			startCursor: string | null
			endCursor: string | null
		}
	}
}

async function seedHourlyBookings(count: number): Promise<string> {
	const resourceId = await makeResource()
	// Sequential (not Promise.all) so ordering is deterministic and adjacent
	// windows never race.
	for (let i = 0; i < count; i++) {
		await bookConfirmed(resourceId, `Slot ${i}`, at(i), at(i + 1))
	}
	return resourceId
}

describe("cursor pagination", () => {
	test("walks the whole list with no gaps or duplicates", async () => {
		const resourceId = await seedHourlyBookings(12)

		const seen: string[] = []
		let after: string | null = null
		let pages = 0

		for (;;) {
			const data: BookingsPage = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
				filter: { resourceId },
				first: 5,
				after,
			})
			pages++
			seen.push(...data.bookings.edges.map((e) => e.node.title))
			if (!data.bookings.pageInfo.hasNextPage) break
			after = data.bookings.pageInfo.endCursor
			expect(after).not.toBeNull()
			if (pages > 10) throw new Error("pagination did not terminate")
		}

		expect(pages).toBe(3) // 5 + 5 + 2
		expect(seen).toHaveLength(12)
		expect(new Set(seen).size).toBe(12)
		expect(seen).toEqual(
			Array.from({ length: 12 }, (_unused, i) => `Slot ${i}`),
		)
	})

	test("is ordered by startTime ascending", async () => {
		const resourceId = await seedHourlyBookings(6)

		const data = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			filter: { resourceId },
			first: 6,
		})

		const times = data.bookings.edges.map((e) => new Date(e.node.startTime).getTime())
		expect(times).toEqual([...times].sort((a, b) => a - b))
	})

	test("reports pageInfo and totalCount correctly", async () => {
		const resourceId = await seedHourlyBookings(7)

		const first = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			filter: { resourceId },
			first: 3,
		})
		expect(first.bookings.totalCount).toBe(7)
		expect(first.bookings.edges).toHaveLength(3)
		expect(first.bookings.pageInfo.hasNextPage).toBe(true)
		expect(first.bookings.pageInfo.hasPreviousPage).toBe(false)

		const last = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			filter: { resourceId },
			first: 3,
			after: first.bookings.pageInfo.endCursor,
		})
		expect(last.bookings.pageInfo.hasPreviousPage).toBe(true)
	})

	test("is stable when a row is inserted before the cursor", async () => {
		// This is the OFFSET bug: with OFFSET 2, inserting an earlier row would
		// shift the window and re-show an already-seen booking.
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "B 10:00", at(10), at(11))
		await bookConfirmed(resourceId, "C 11:00", at(11), at(12))
		await bookConfirmed(resourceId, "D 12:00", at(12), at(13))

		const page1 = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			filter: { resourceId },
			first: 2,
		})
		expect(page1.bookings.edges.map((e) => e.node.title)).toEqual([
			"B 10:00",
			"C 11:00",
		])

		// Insert an EARLIER booking between page fetches.
		await bookConfirmed(resourceId, "A 08:00", at(8), at(9))

		const page2 = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			filter: { resourceId },
			first: 2,
			after: page1.bookings.pageInfo.endCursor,
		})

		expect(page2.bookings.edges.map((e) => e.node.title)).toEqual(["D 12:00"])
	})

	test("breaks ties on id so identical startTimes paginate safely", async () => {
		// Same startTime on two different resources: without the id tie-breaker
		// the cursor would be ambiguous and one row could be skipped.
		const roomA = await makeResource("Tie A")
		const roomB = await makeResource("Tie B")
		await bookConfirmed(roomA, "A", at(10), at(11))
		await bookConfirmed(roomB, "B", at(10), at(11))

		const page1 = await gqlOk<BookingsPage>(BOOKINGS_PAGE, { first: 1 })
		const page2 = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			first: 1,
			after: page1.bookings.pageInfo.endCursor,
		})

		const ids = [
			page1.bookings.edges[0]?.node.id,
			page2.bookings.edges[0]?.node.id,
		]
		expect(new Set(ids).size).toBe(2)
		expect(page2.bookings.pageInfo.hasNextPage).toBe(false)
	})

	test("rejects an invalid cursor and a bad page size", async () => {
		const badCursor = await gql(BOOKINGS_PAGE, { first: 2, after: "!!!not-base64" })
		expect(errorCodes(badCursor)).toEqual(["BAD_USER_INPUT"])

		const tooLarge = await gql(BOOKINGS_PAGE, { first: 1000 })
		expect(errorCodes(tooLarge)).toEqual(["BAD_USER_INPUT"])

		const zero = await gql(BOOKINGS_PAGE, { first: 0 })
		expect(errorCodes(zero)).toEqual(["BAD_USER_INPUT"])
	})
})

describe("booking filters", () => {
	test("filters by status", async () => {
		const resourceId = await makeResource()
		const keep = await bookConfirmed(resourceId, "Keep", at(10), at(11))
		const drop = await bookConfirmed(resourceId, "Drop", at(12), at(13))
		await prisma.booking.update({
			where: { id: drop },
			data: { status: "CANCELLED" },
		})

		const confirmed = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			filter: { status: "CONFIRMED" },
		})
		expect(confirmed.bookings.edges.map((e) => e.node.id)).toEqual([keep])

		const cancelled = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			filter: { status: "CANCELLED" },
		})
		expect(cancelled.bookings.edges.map((e) => e.node.id)).toEqual([drop])
	})

	test("filters by overlapping time window, half-open", async () => {
		const resourceId = await makeResource()
		await bookConfirmed(resourceId, "08-09", at(8), at(9))
		await bookConfirmed(resourceId, "09-10", at(9), at(10))
		await bookConfirmed(resourceId, "10-11", at(10), at(11))
		await bookConfirmed(resourceId, "11-12", at(11), at(12))

		// Window [09:00, 11:00): includes 09-10 and 10-11.
		// Excludes 08-09 (ends exactly at `from`) and 11-12 (starts exactly at `to`).
		const data = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			filter: { resourceId, from: at(9), to: at(11) },
		})
		expect(data.bookings.edges.map((e) => e.node.title)).toEqual([
			"09-10",
			"10-11",
		])
	})

	test("filters by resource", async () => {
		const roomA = await makeResource("Filter A")
		const roomB = await makeResource("Filter B")
		await bookConfirmed(roomA, "In A", at(10), at(11))
		await bookConfirmed(roomB, "In B", at(10), at(11))

		const data = await gqlOk<BookingsPage>(BOOKINGS_PAGE, {
			filter: { resourceId: roomA },
		})
		expect(data.bookings.edges.map((e) => e.node.title)).toEqual(["In A"])
		expect(data.bookings.totalCount).toBe(1)
	})
})

describe("nested Resource.bookings", () => {
	const RESOURCE_WITH_BOOKINGS = /* GraphQL */ `
		query ResourceWithBookings($id: ID!, $first: Int) {
			resource(id: $id) {
				id
				name
				capacity
				bookings(first: $first) {
					totalCount
					nodes {
						title
						status
					}
					pageInfo {
						hasNextPage
					}
				}
			}
		}
	`

	test("defaults to confirmed bookings only", async () => {
		const resourceId = await makeResource("Nested room")
		await bookConfirmed(resourceId, "Confirmed", at(10), at(11))
		const cancelled = await bookConfirmed(resourceId, "Cancelled", at(12), at(13))
		await prisma.booking.update({
			where: { id: cancelled },
			data: { status: "CANCELLED" },
		})

		const data = await gqlOk<{
			resource: {
				bookings: { totalCount: number; nodes: Array<{ title: string }> }
			}
		}>(RESOURCE_WITH_BOOKINGS, { id: resourceId, first: 10 })

		expect(data.resource.bookings.nodes.map((n) => n.title)).toEqual([
			"Confirmed",
		])
		expect(data.resource.bookings.totalCount).toBe(1)
	})

	test("returns null for an unknown resource", async () => {
		const data = await gqlOk<{ resource: null }>(RESOURCE_WITH_BOOKINGS, {
			id: crypto.randomUUID(),
			first: 5,
		})
		expect(data.resource).toBeNull()
	})
})
