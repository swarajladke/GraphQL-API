import type { Prisma, Booking, Resource } from "@prisma/client"
import type { GraphQLContext } from "../context.ts"
import {
	buildConnection,
	decodeCursor,
	normalizeFirst,
	type Connection,
} from "../lib/pagination.ts"

/**
 * A connection plus the `where` clause that produced it, so `totalCount` can be
 * resolved lazily. Clients that never select `totalCount` never pay for the
 * COUNT(*).
 */
export type BookingConnectionSource = Connection<Booking> & {
	where: Prisma.BookingWhereInput
}

export type ResourceConnectionSource = Connection<Resource> & {
	where: Prisma.ResourceWhereInput
}

/**
 * Keyset pagination over bookings, ordered by (startTime, id).
 *
 * The `id` tie-breaker matters: `startTime` alone is not unique, and without a
 * total order two bookings starting at the same instant could be returned twice
 * or skipped across a page boundary.
 */
export async function paginateBookings(
	ctx: GraphQLContext,
	where: Prisma.BookingWhereInput,
	args: { first?: number | null; after?: string | null },
): Promise<BookingConnectionSource> {
	const first = normalizeFirst(args.first)
	const after = args.after ? decodeCursor(args.after) : null

	const keysetFilter: Prisma.BookingWhereInput = after
		? {
				OR: [
					{ startTime: { gt: after.sortValue } },
					{ startTime: after.sortValue, id: { gt: after.id } },
				],
			}
		: {}

	const rows = await ctx.prisma.booking.findMany({
		where: after ? { AND: [where, keysetFilter] } : where,
		orderBy: [{ startTime: "asc" }, { id: "asc" }],
		take: first + 1, // over-fetch by one to compute hasNextPage in a single query
	})

	const connection = buildConnection(rows, first, after !== null, (node) => ({
		sortValue: node.startTime,
		id: node.id,
	}))

	return { ...connection, where }
}

/** Keyset pagination over resources, ordered by (createdAt, id). */
export async function paginateResources(
	ctx: GraphQLContext,
	where: Prisma.ResourceWhereInput,
	args: { first?: number | null; after?: string | null },
): Promise<ResourceConnectionSource> {
	const first = normalizeFirst(args.first)
	const after = args.after ? decodeCursor(args.after) : null

	const keysetFilter: Prisma.ResourceWhereInput = after
		? {
				OR: [
					{ createdAt: { gt: after.sortValue } },
					{ createdAt: after.sortValue, id: { gt: after.id } },
				],
			}
		: {}

	const rows = await ctx.prisma.resource.findMany({
		where: after ? { AND: [where, keysetFilter] } : where,
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
		take: first + 1,
	})

	const connection = buildConnection(rows, first, after !== null, (node) => ({
		sortValue: node.createdAt,
		id: node.id,
	}))

	return { ...connection, where }
}

/** Translate a `{ status, from, to }` filter into a Prisma where clause. */
export function bookingWhere(filter: {
	resourceId?: string | null
	status?: "CONFIRMED" | "CANCELLED" | null
	from?: Date | null
	to?: Date | null
}): Prisma.BookingWhereInput {
	const where: Prisma.BookingWhereInput = {}

	if (filter.resourceId) where.resourceId = filter.resourceId
	if (filter.status) where.status = filter.status

	// "Overlaps the window", using the same half-open logic as conflict
	// detection: a booking ending exactly at `from` is outside the window.
	if (filter.to) where.startTime = { lt: filter.to }
	if (filter.from) where.endTime = { gt: filter.from }

	return where
}
