-- Runs once on first container start (docker-entrypoint-initdb.d).
-- Creates the dedicated test database so `bun test` never touches dev data.
CREATE DATABASE booking_test OWNER booking;
