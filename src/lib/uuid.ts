import { badUserInput } from "./errors.ts"

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
	return UUID_RE.test(value)
}

/**
 * Guards ID inputs before they reach Postgres.
 *
 * Without this, `findUnique({ where: { id: "abc" } })` on a `uuid` column raises
 * a raw driver cast error, which leaks database internals through the GraphQL
 * response. Validating up front turns it into a clean BAD_USER_INPUT.
 */
export function assertUuid(value: string, field: string): string {
	if (!isUuid(value)) {
		throw badUserInput(`"${field}" must be a UUID.`, { field })
	}
	return value
}
