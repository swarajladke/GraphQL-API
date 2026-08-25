import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { makeExecutableSchema } from "@graphql-tools/schema"
import type { GraphQLSchema } from "graphql"
import { resolvers } from "../resolvers/index.ts"

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Schema-first: the SDL in `schema.graphql` is the contract, and the resolver
 * map is checked against it at startup by `makeExecutableSchema`. A typo in a
 * resolver field name fails fast on boot rather than at request time.
 */
export const typeDefs: string = readFileSync(
	join(here, "schema.graphql"),
	"utf8",
)

export const schema: GraphQLSchema = makeExecutableSchema({
	typeDefs,
	resolvers,
	resolverValidationOptions: {
		requireResolversToMatchSchema: "error",
	},
})
