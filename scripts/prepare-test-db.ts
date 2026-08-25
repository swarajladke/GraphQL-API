/**
 * Applies migrations to the test database before the suite runs.
 *
 * `prisma migrate deploy` is used rather than `migrate dev` so it never prompts
 * and never tries to generate a new migration — it just replays the committed
 * SQL, which is exactly what CI needs.
 */
const databaseUrl =
	process.env.TEST_DATABASE_URL ??
	(await Bun.file(".env.test")
		.text()
		.then(
			(text) =>
				/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m.exec(text)?.[1]?.trim() ?? null,
		)
		.catch(() => null))

if (!databaseUrl) {
	console.error(
		"✗ No test database configured.\n" +
			"  Copy .env.test.example to .env.test (or set TEST_DATABASE_URL).",
	)
	process.exit(1)
}

if (!/_test(\?|$)/.test(databaseUrl)) {
	// The suite TRUNCATEs tables, so refuse to point at anything that does not
	// look like a throwaway database.
	console.error(
		`✗ Refusing to run: test database name must end in "_test" (got ${databaseUrl.replace(/:[^:@]+@/, ":***@")})`,
	)
	process.exit(1)
}

console.log("→ applying migrations to the test database…")

const proc = Bun.spawn(["bunx", "prisma", "migrate", "deploy"], {
	env: { ...process.env, DATABASE_URL: databaseUrl },
	stdout: "inherit",
	stderr: "inherit",
})

const exitCode = await proc.exited
if (exitCode !== 0) process.exit(exitCode)
console.log("✓ test database ready")
