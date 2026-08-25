import { badUserInput } from "./errors.ts"

export const DEFAULT_PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 100

export type Keyset = {
	/** The sort key of the last item on the previous page. */
	sortValue: Date
	/** Tie-breaker so the ordering is a total order and cursors are stable. */
	id: string
}

/**
 * Cursors are opaque base64url of `<iso timestamp>|<uuid>`.
 *
 * Keyset ("seek") pagination rather than OFFSET, because:
 *  - OFFSET N makes Postgres walk and discard N rows — page 500 is slow.
 *  - OFFSET drifts: inserting an earlier booking shifts every later page and
 *    the client silently skips or repeats rows.
 * Keyset paging is O(log n) via `bookings_start_time_id_idx` and is stable
 * under concurrent inserts.
 */
export function encodeCursor(keyset: Keyset): string {
	const raw = `${keyset.sortValue.toISOString()}|${keyset.id}`
	return Buffer.from(raw, "utf8").toString("base64url")
}

export function decodeCursor(cursor: string): Keyset {
	let raw: string
	try {
		raw = Buffer.from(cursor, "base64url").toString("utf8")
	} catch {
		throw badUserInput('"after" is not a valid cursor.', { field: "after" })
	}

	const separator = raw.lastIndexOf("|")
	if (separator === -1) {
		throw badUserInput('"after" is not a valid cursor.', { field: "after" })
	}

	const iso = raw.slice(0, separator)
	const id = raw.slice(separator + 1)
	const sortValue = new Date(iso)

	if (Number.isNaN(sortValue.getTime()) || id.length === 0) {
		throw badUserInput('"after" is not a valid cursor.', { field: "after" })
	}

	return { sortValue, id }
}

/** Clamp and validate the `first` argument. */
export function normalizeFirst(first: number | null | undefined): number {
	if (first === null || first === undefined) return DEFAULT_PAGE_SIZE
	if (!Number.isInteger(first) || first <= 0) {
		throw badUserInput('"first" must be a positive integer.', {
			field: "first",
		})
	}
	if (first > MAX_PAGE_SIZE) {
		throw badUserInput(`"first" may not exceed ${MAX_PAGE_SIZE}.`, {
			field: "first",
			max: MAX_PAGE_SIZE,
		})
	}
	return first
}

export type PageInfo = {
	hasNextPage: boolean
	hasPreviousPage: boolean
	startCursor: string | null
	endCursor: string | null
}

export type Connection<TNode> = {
	edges: Array<{ cursor: string; node: TNode }>
	nodes: TNode[]
	pageInfo: PageInfo
}

/**
 * Turn an over-fetched, ordered row list into a connection.
 *
 * `rows` must contain up to `first + 1` items; the extra row is what tells us
 * `hasNextPage` without a second query.
 */
export function buildConnection<TNode>(
	rows: readonly TNode[],
	first: number,
	hasPreviousPage: boolean,
	toKeyset: (node: TNode) => Keyset,
): Connection<TNode> {
	const hasNextPage = rows.length > first
	const page = hasNextPage ? rows.slice(0, first) : rows.slice()
	const edges = page.map((node) => ({
		cursor: encodeCursor(toKeyset(node)),
		node,
	}))

	return {
		edges,
		nodes: page,
		pageInfo: {
			hasNextPage,
			hasPreviousPage,
			startCursor: edges[0]?.cursor ?? null,
			endCursor: edges[edges.length - 1]?.cursor ?? null,
		},
	}
}
