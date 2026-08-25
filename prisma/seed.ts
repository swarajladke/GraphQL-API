/**
 * Development seed: three resources and a realistic day of bookings, including
 * a back-to-back pair and a cancelled booking whose slot is reused — so the
 * interesting behaviours are visible in GraphiQL immediately.
 */
import { prisma } from "../src/prisma.ts"

function todayAt(hour: number, minute = 0): Date {
	const now = new Date()
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute),
	)
}

await prisma.booking.deleteMany()
await prisma.resource.deleteMany()

const [focusRoom, boardroom, projector] = await Promise.all([
	prisma.resource.create({ data: { name: "Focus Room", capacity: 4 } }),
	prisma.resource.create({ data: { name: "Boardroom", capacity: 14 } }),
	prisma.resource.create({ data: { name: "Projector — Cart A", capacity: 1 } }),
])

await prisma.booking.createMany({
	data: [
		// Back-to-back pair: legal because intervals are half-open.
		{
			resourceId: focusRoom.id,
			title: "Daily standup",
			startTime: todayAt(9),
			endTime: todayAt(9, 30),
			updatedAt: new Date(),
		},
		{
			resourceId: focusRoom.id,
			title: "1:1",
			startTime: todayAt(9, 30),
			endTime: todayAt(10),
			updatedAt: new Date(),
		},
		// A cancelled booking…
		{
			resourceId: boardroom.id,
			title: "Postponed roadmap review",
			startTime: todayAt(11),
			endTime: todayAt(12),
			status: "CANCELLED",
			updatedAt: new Date(),
		},
		// …whose exact slot is reused by a confirmed booking.
		{
			resourceId: boardroom.id,
			title: "Customer demo",
			startTime: todayAt(11),
			endTime: todayAt(12),
			updatedAt: new Date(),
		},
		{
			resourceId: projector.id,
			title: "All-hands AV setup",
			startTime: todayAt(15),
			endTime: todayAt(16),
			updatedAt: new Date(),
		},
	],
})

console.log("✓ seeded 3 resources and 5 bookings")
await prisma.$disconnect()
