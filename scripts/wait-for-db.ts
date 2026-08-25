/**
 * Blocks until Postgres accepts queries, so `bun run db:up` can be chained
 * straight into `prisma migrate` in scripts and CI without a sleep.
 */
import { PrismaClient } from "@prisma/client"

const TIMEOUT_MS = 60_000
const INTERVAL_MS = 500

const prisma = new PrismaClient()
const deadline = Date.now() + TIMEOUT_MS

while (true) {
	try {
		await prisma.$queryRaw`SELECT 1`
		console.log("✓ database is accepting connections")
		break
	} catch (error) {
		if (Date.now() > deadline) {
			console.error("✗ database did not become ready in time")
			console.error(error)
			await prisma.$disconnect()
			process.exit(1)
		}
		await Bun.sleep(INTERVAL_MS)
	}
}

await prisma.$disconnect()
