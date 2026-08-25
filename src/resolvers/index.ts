import type { Booking, BookingStatus, Resource } from "@prisma/client"
import { type GraphQLContext, loadResource } from "../context.ts"
import {
	cancelBooking,
	createBooking,
	createResource,
	deleteBooking,
	getAvailability,
	rescheduleBooking,
	type AvailabilityResult,
} from "../lib/booking-service.ts"
import { assertUuid } from "../lib/uuid.ts"
import { DateTimeScalar } from "./scalars.ts"
import {
	bookingWhere,
	paginateBookings,
	paginateResources,
	type BookingConnectionSource,
	type ResourceConnectionSource,
} from "./connections.ts"

type BookingFilterInput = {
	resourceId?: string | null
	status?: BookingStatus | null
	from?: Date | null
	to?: Date | null
} | null

type ResourceBookingFilterInput = {
	status?: BookingStatus | null
	from?: Date | null
	to?: Date | null
} | null

type PageArgs = { first?: number | null; after?: string | null }

export const resolvers = {
	DateTime: DateTimeScalar,

	Query: {
		resources: (
			_parent: unknown,
			args: PageArgs,
			ctx: GraphQLContext,
		): Promise<ResourceConnectionSource> => paginateResources(ctx, {}, args),

		resource: (
			_parent: unknown,
			args: { id: string },
			ctx: GraphQLContext,
		): Promise<Resource | null> => {
			assertUuid(args.id, "id")
			return loadResource(ctx, args.id)
		},

		bookings: (
			_parent: unknown,
			args: PageArgs & { filter?: BookingFilterInput },
			ctx: GraphQLContext,
		): Promise<BookingConnectionSource> => {
			const filter = args.filter ?? {}
			if (filter.resourceId) assertUuid(filter.resourceId, "filter.resourceId")
			return paginateBookings(ctx, bookingWhere(filter), args)
		},

		booking: (
			_parent: unknown,
			args: { id: string },
			ctx: GraphQLContext,
		): Promise<Booking | null> => {
			assertUuid(args.id, "id")
			return ctx.prisma.booking.findUnique({ where: { id: args.id } })
		},

		availability: (
			_parent: unknown,
			args: { resourceId: string; from: Date; to: Date },
			ctx: GraphQLContext,
		): Promise<AvailabilityResult> => getAvailability(ctx.prisma, args),
	},

	Mutation: {
		createResource: (
			_parent: unknown,
			args: { input: { name: string; capacity: number } },
			ctx: GraphQLContext,
		) => createResource(ctx.prisma, args.input),

		createBooking: (
			_parent: unknown,
			args: {
				input: {
					resourceId: string
					title: string
					startTime: Date
					endTime: Date
				}
			},
			ctx: GraphQLContext,
		): Promise<Booking> => createBooking(ctx.prisma, args.input),

		rescheduleBooking: (
			_parent: unknown,
			args: { input: { id: string; startTime: Date; endTime: Date } },
			ctx: GraphQLContext,
		): Promise<Booking> => rescheduleBooking(ctx.prisma, args.input),

		cancelBooking: (
			_parent: unknown,
			args: { id: string },
			ctx: GraphQLContext,
		): Promise<Booking> => cancelBooking(ctx.prisma, args.id),

		deleteBooking: (
			_parent: unknown,
			args: { id: string },
			ctx: GraphQLContext,
		) => deleteBooking(ctx.prisma, args.id),
	},

	Resource: {
		/**
		 * Nested, independently-paginated bookings for one resource.
		 * Defaults to CONFIRMED so the common "show me this room's schedule"
		 * query does not surface cancelled noise.
		 */
		bookings: (
			parent: Resource,
			args: PageArgs & { filter?: ResourceBookingFilterInput },
			ctx: GraphQLContext,
		): Promise<BookingConnectionSource> => {
			const filter = args.filter ?? {}
			return paginateBookings(
				ctx,
				bookingWhere({
					resourceId: parent.id,
					status: filter.status ?? "CONFIRMED",
					from: filter.from ?? null,
					to: filter.to ?? null,
				}),
				args,
			)
		},
	},

	Booking: {
		resource: (
			parent: Booking,
			_args: unknown,
			ctx: GraphQLContext,
		): Promise<Resource | null> => loadResource(ctx, parent.resourceId),
	},

	BookingConnection: {
		// Lazy COUNT(*): only executed if the client actually selects totalCount.
		totalCount: (parent: BookingConnectionSource, _args: unknown, ctx: GraphQLContext) =>
			ctx.prisma.booking.count({ where: parent.where }),
	},

	ResourceConnection: {
		totalCount: (
			parent: ResourceConnectionSource,
			_args: unknown,
			ctx: GraphQLContext,
		) => ctx.prisma.resource.count({ where: parent.where }),
	},

	Availability: {
		resource: (
			parent: AvailabilityResult,
			_args: unknown,
			ctx: GraphQLContext,
		): Promise<Resource | null> => loadResource(ctx, parent.resourceId),
	},
}
