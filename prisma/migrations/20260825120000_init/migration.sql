-- Room Booking API :: initial schema
--
-- gen_random_uuid() lives in pgcrypto (built into PG13+ core, extension kept for
-- portability). btree_gist is required so that a GiST exclusion constraint can
-- use the `=` operator on a uuid column alongside the `&&` range operator.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "resources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "resource_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "start_time" TIMESTAMPTZ(3) NOT NULL,
    "end_time" TIMESTAMPTZ(3) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'CONFIRMED',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "resources_name_key" ON "resources"("name");
CREATE INDEX "resources_created_at_id_idx" ON "resources"("created_at", "id");

-- CreateIndex
CREATE INDEX "bookings_resource_status_start_idx" ON "bookings"("resource_id", "status", "start_time");
CREATE INDEX "bookings_start_time_id_idx" ON "bookings"("start_time", "id");
CREATE INDEX "bookings_resource_start_idx" ON "bookings"("resource_id", "start_time");

-- AddForeignKey
ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_resource_id_fkey"
    FOREIGN KEY ("resource_id") REFERENCES "resources"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Data integrity: capacity must be positive.
ALTER TABLE "resources"
    ADD CONSTRAINT "resources_capacity_positive" CHECK ("capacity" > 0);

-- Data integrity: a booking must have a strictly positive duration.
-- (Zero-length bookings would never conflict with anything under half-open
-- interval semantics, so they are rejected outright.)
ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_end_after_start" CHECK ("end_time" > "start_time");

-- ---------------------------------------------------------------------------
-- THE no-overlap guarantee.
--
-- `tstzrange(start, end, '[)')` models the booking as a half-open interval, so
-- 10:00-11:00 and 11:00-12:00 do NOT overlap (back-to-back bookings allowed).
--
-- The `WHERE (status = 'CONFIRMED')` predicate makes this a *partial*
-- exclusion constraint: cancelled bookings are excluded from the index, so
-- cancelling a booking frees its slot immediately and any number of cancelled
-- bookings may pile up on the same range.
--
-- This is enforced by the database itself, which means it holds even under
-- perfectly-timed concurrent inserts, direct SQL access, or a buggy resolver.
-- The application-level check exists to return a friendly error, not to be the
-- source of truth.
-- ---------------------------------------------------------------------------
ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_no_overlap"
    EXCLUDE USING gist (
        "resource_id" WITH =,
        tstzrange("start_time", "end_time", '[)') WITH &&
    ) WHERE ("status" = 'CONFIRMED');
