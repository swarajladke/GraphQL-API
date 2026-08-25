import { createYoga, maskError } from "graphql-yoga"
import { createContext } from "./context.ts"
import { prisma } from "./prisma.ts"
import { schema } from "./schema/index.ts"

const isProduction = process.env.NODE_ENV === "production"

export const yoga = createYoga({
	schema,
	context: createContext,
	graphiql: !isProduction,
	landingPage: false,
	maskedErrors: {
		/**
		 * Domain errors carry an `extensions.code` we chose deliberately
		 * (BAD_USER_INPUT / NOT_FOUND / BOOKING_CONFLICT) and are safe to expose.
		 * Anything else is an unexpected bug and gets masked in production so we
		 * never leak SQL, connection strings, or stack traces to clients.
		 */
		maskError(error, message, isDev) {
			const code = (error as { extensions?: { code?: unknown } })?.extensions
				?.code
			if (typeof code === "string") return error as Error
			return maskError(error, message, isDev || !isProduction)
		},
	},
})

const port = Number(process.env.PORT ?? 4000)

const server = Bun.serve({
	port,
	fetch: yoga,
})

console.log(`▶ Room Booking API ready at http://localhost:${server.port}/graphql`)

async function shutdown(signal: string): Promise<void> {
	console.log(`\n${signal} received — draining connections…`)
	await server.stop()
	await prisma.$disconnect()
	process.exit(0)
}

process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
