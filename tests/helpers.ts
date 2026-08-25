import { execute, parse, type ExecutionResult } from "graphql"
import { createContext } from "../src/context.ts"
import { prisma } from "../src/prisma.ts"
import { schema } from "../src/schema/index.ts"

/**
 * Execute an operation against the real schema, real resolvers and real
 * database — only the HTTP layer is skipped.
 *
 * Every test therefore exercises scalar parsing, input validation, the service
 * layer, Prisma and the Postgres constraints together. Unit-testing the overlap
 * maths alone would happily pass while the SQL predicate was wrong, so these
 * are deliberately integration tests.
 *
 * Each call builds a fresh context, mirroring one HTTP request (and giving each
 * request its own resource cache).
 */
export async function gql<TData = Record<string, unknown>>(
	source: string,
	variableValues: Record<string, unknown> = {},
): Promise<ExecutionResult<TData>> {
	return (await execute({
		schema,
		document: parse(source),
		contextValue: createContext(),
		variableValues,
	})) as ExecutionResult<TData>
}

/** Execute and throw if the operation produced any GraphQL error. */
export async function gqlOk<TData = Record<string, unknown>>(
	source: string,
	variableValues: Record<string, unknown> = {},
): Promise<TData> {
	const result = await gql<TData>(source, variableValues)
	if (result.errors?.length) {
		throw new Error(
			`Unexpected GraphQL errors: ${result.errors.map((e) => e.message).join(" | ")}`,
		)
	}
	if (!result.data) throw new Error("Expected data in GraphQL result")
	return result.data
}

export function errorCodes(result: ExecutionResult): string[] {
	return (result.errors ?? []).map((error) =>
		String(error.extensions?.["code"] ?? "UNKNOWN"),
	)
}

/**
 * Wipe all data between tests.
 *
 * TRUNCATE ... CASCADE rather than deleteMany() so ordering/FK concerns
 * disappear and it stays fast as the suite grows.
 */
export async function resetDatabase(): Promise<void> {
	await prisma.$executeRawUnsafe(
		'TRUNCATE TABLE "bookings", "resources" RESTART IDENTITY CASCADE',
	)
}

export const CREATE_RESOURCE = /* GraphQL */ `
	mutation CreateResource($input: CreateResourceInput!) {
		createResource(input: $input) {
			id
			name
			capacity
			createdAt
		}
	}
`

export const CREATE_BOOKING = /* GraphQL */ `
	mutation CreateBooking($input: CreateBookingInput!) {
		createBooking(input: $input) {
			id
			title
			startTime
			endTime
			status
			resource {
				id
			}
		}
	}
`

export const RESCHEDULE_BOOKING = /* GraphQL */ `
	mutation RescheduleBooking($input: RescheduleBookingInput!) {
		rescheduleBooking(input: $input) {
			id
			startTime
			endTime
			status
		}
	}
`

export const CANCEL_BOOKING = /* GraphQL */ `
	mutation CancelBooking($id: ID!) {
		cancelBooking(id: $id) {
			id
			status
		}
	}
`

export const DELETE_BOOKING = /* GraphQL */ `
	mutation DeleteBooking($id: ID!) {
		deleteBooking(id: $id) {
			id
			deleted
		}
	}
`

export const AVAILABILITY = /* GraphQL */ `
	query Availability($resourceId: ID!, $from: DateTime!, $to: DateTime!) {
		availability(resourceId: $resourceId, from: $from, to: $to) {
			isAvailable
			conflicts {
				id
				title
			}
			freeSlots {
				startTime
				endTime
			}
		}
	}
`

/** Helper: a fresh resource, returning its id. */
export async function makeResource(
	name = `Room ${crypto.randomUUID().slice(0, 8)}`,
	capacity = 8,
): Promise<string> {
	const data = await gqlOk<{ createResource: { id: string } }>(
		CREATE_RESOURCE,
		{ input: { name, capacity } },
	)
	return data.createResource.id
}

/** Helper: an ISO instant on a fixed test day, e.g. `at(10)` → 10:00Z. */
export function at(hour: number, minute = 0): string {
	const date = new Date(Date.UTC(2026, 8, 1, hour, minute, 0, 0))
	return date.toISOString()
}

export async function bookConfirmed(
	resourceId: string,
	title: string,
	startTime: string,
	endTime: string,
): Promise<string> {
	const data = await gqlOk<{ createBooking: { id: string } }>(CREATE_BOOKING, {
		input: { resourceId, title, startTime, endTime },
	})
	return data.createBooking.id
}
