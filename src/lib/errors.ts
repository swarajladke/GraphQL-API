import { GraphQLError } from "graphql"

/**
 * Stable, machine-readable error codes surfaced in
 * `errors[].extensions.code`. Clients branch on these, never on message text.
 */
export const ErrorCode = {
	BAD_USER_INPUT: "BAD_USER_INPUT",
	NOT_FOUND: "NOT_FOUND",
	BOOKING_CONFLICT: "BOOKING_CONFLICT",
	CONFLICT: "CONFLICT",
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]

function gqlError(
	message: string,
	code: ErrorCodeValue,
	extensions: Record<string, unknown> = {},
): GraphQLError {
	return new GraphQLError(message, {
		extensions: { code, ...extensions },
	})
}

export function badUserInput(
	message: string,
	extensions: Record<string, unknown> = {},
): GraphQLError {
	return gqlError(message, ErrorCode.BAD_USER_INPUT, extensions)
}

export function notFound(entity: string, id: string): GraphQLError {
	return gqlError(`${entity} "${id}" was not found.`, ErrorCode.NOT_FOUND, {
		entity,
		id,
	})
}

export function bookingConflict(
	message: string,
	conflictingBookingIds: readonly string[] = [],
): GraphQLError {
	return gqlError(message, ErrorCode.BOOKING_CONFLICT, {
		conflictingBookingIds,
	})
}

export function alreadyExists(message: string): GraphQLError {
	return gqlError(message, ErrorCode.CONFLICT)
}
