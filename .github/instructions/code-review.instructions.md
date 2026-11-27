---
applyTo: "**"
excludeAgent: "cloud-agent"
---

# Code review instructions

Sprocket is a single-user cycling training tracker: Nuxt 4 (client in `app/`, Nitro server in `server/`, shared code in `shared/`), PostgreSQL with Drizzle, pnpm. It runs as a single process. Merging to `main` deploys to production and runs migrations.

## What to review

In priority order:

1. Security vulnerabilities and data loss.
2. Correctness: bugs, unhandled edge cases, race conditions.
3. Regressions: changed behaviour of existing callers, API shapes or stored data.
4. Performance: N+1 queries, unbounded loops, queries or memory use, work repeated on hot paths.
5. Documentation that no longer matches the code.
6. Readability that is likely to cause a future mistake.

## What to report

- Report an issue only if you can name the input or sequence of events that triggers it and the resulting wrong behaviour. For documentation, quote the statement and name the code that contradicts it.
- If an issue depends on something you could not verify, say what you assumed.
- State the impact and suggest a concrete fix.
- Skip formatting, naming preferences, style that doesn't hurt readability, and speculative refactors.
- Don't report problems in code the pull request doesn't touch or affect.
- Finding nothing is an acceptable result.

## Documentation alignment

For every behaviour change, check the code comments, `README.md`, `infra/README.md`, `CLAUDE.md` and the env examples (`.env.example`, `infra/env.example`). Flag:

- Comments or docs that now describe old behaviour, including in unchanged lines.
- Renamed or removed files, routes, scripts, tables or environment variables still referenced by their old name.
- New environment variables, routes, tables, scripts or scheduled jobs that are undocumented.
- Changes to `infra/` files that need a matching manual step which the docs don't mention.

Don't ask for comments on self-explanatory code.

## Project rules

Security:

- Every query that reads or changes user data must be scoped to the user. Workout mutations filter by both `id` and `userId`.
- API routes require a session unless intentionally public. Public webhook, sync and reconcile routes must check their secret in constant time before any database, filesystem or outbound network work.
- Uploaded FIT and `.zwo` files and third-party responses are untrusted. Keep size, duration, depth and repeat limits.
- Never log or send to Sentry any secrets, tokens, cookies, request bodies or personal data.
- Registration stays disabled. Login always runs the password hash, even for unknown emails.

Data correctness:

- Strava activity, athlete and segment effort ids are strings end to end. Use `id_str`, or `parseJsonExactIds` for segment efforts.
- CTL and ATL use `1/42` and `1/7` decay, and TSB is `CTL - ATL` after that day's TSS. Server and client projections must agree.
- Every workout write invalidates the metrics cache.
- `ftp_watts` is a sparse marker. FTP on a date is the latest marker on or before it.
- Logged TSS, power and duration come from parsed FIT files, not Strava's numbers.
- Check date handling for timezone shifts. A ride belongs to its local calendar day.
- Wahoo refresh tokens rotate on every use and must be persisted.

Operations:

- Schema changes need a generated migration in `drizzle/`, safe to run on existing production data.
- Files that must survive a deploy can't be written inside the release directory.
- `shared/utils/zwo.ts` has no imports and uses only erasable TypeScript.

Conventions:

- Use pnpm. Question new dependencies that a small helper could replace.
- Fonts are self-hosted and icons are statically named Heroicons or local SVG components.
