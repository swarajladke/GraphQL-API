import type { PrismaClient, Resource } from "@prisma/client"
import { prisma } from "./prisma.ts"

/**
 * Per-request context.
 *
 * `resourceCache` is a deliberately tiny request-scoped cache. `Booking.resource`
 * is a very common selection and a list of 50 bookings on 3 rooms would
 * otherwise issue 50 identical queries. A full DataLoader would also batch, but
 * caching alone removes the pathological case with a fraction of the machinery.
 */
export type GraphQLContext = {
	prisma: PrismaClient
	resourceCache: Map<string, Promise<Resource | null>>
}

export function createContext(): GraphQLContext {
	return {
		prisma,
		resourceCache: new Map(),
	}
}

export function loadResource(
	ctx: GraphQLContext,
	id: string,
): Promise<Resource | null> {
	const cached = ctx.resourceCache.get(id)
	if (cached) return cached

	const pending = ctx.prisma.resource.findUnique({ where: { id } })
	ctx.resourceCache.set(id, pending)
	return pending
}
