import { PrismaClient } from "@prisma/client"

const globalForPrisma = globalThis as unknown as {
	prisma?: PrismaClient
}

/**
 * A single PrismaClient for the process.
 *
 * Cached on `globalThis` so `bun --watch` reloads (and repeated test-file
 * imports) do not open a new connection pool every time.
 */
export const prisma: PrismaClient =
	globalForPrisma.prisma ??
	new PrismaClient({
		log:
			process.env.PRISMA_LOG === "query"
				? ["query", "warn", "error"]
				: ["warn", "error"],
	})

if (process.env.NODE_ENV !== "production") {
	globalForPrisma.prisma = prisma
}
