import { GraphQLError, GraphQLScalarType, Kind } from "graphql"

function parseIsoInstant(value: unknown): Date {
	if (value instanceof Date) {
		if (Number.isNaN(value.getTime())) {
			throw new GraphQLError("DateTime received an invalid Date.")
		}
		return value
	}

	if (typeof value !== "string") {
		throw new GraphQLError(
			`DateTime must be an ISO-8601 string, received ${typeof value}.`,
		)
	}

	// Require an explicit offset (`Z` or ±HH:MM). A bare "2026-09-01T10:00:00"
	// would otherwise be silently interpreted in the server's local timezone,
	// which makes overlap behaviour depend on where the process runs.
	if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
		throw new GraphQLError(
			`DateTime "${value}" must include a UTC offset, e.g. "2026-09-01T10:00:00Z".`,
		)
	}

	const parsed = new Date(value)
	if (Number.isNaN(parsed.getTime())) {
		throw new GraphQLError(`DateTime "${value}" is not a valid ISO-8601 instant.`)
	}
	return parsed
}

export const DateTimeScalar = new GraphQLScalarType<Date, string>({
	name: "DateTime",
	description: "An ISO-8601 instant, always serialised in UTC.",

	serialize(value) {
		if (value instanceof Date) return value.toISOString()
		if (typeof value === "string") return parseIsoInstant(value).toISOString()
		throw new GraphQLError("DateTime cannot serialize this value.")
	},

	parseValue(value) {
		return parseIsoInstant(value)
	},

	parseLiteral(ast) {
		if (ast.kind !== Kind.STRING) {
			throw new GraphQLError("DateTime must be written as a string literal.", {
				nodes: ast,
			})
		}
		return parseIsoInstant(ast.value)
	},
})
