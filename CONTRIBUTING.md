# Contributing

Read the [design](docs/design.md) and [roadmap](docs/roadmap.md) first. Discuss substantial API or architecture changes in an issue before implementation. Use synthetic examples; never include credentials or captured production data.

## Workflow

1. Fork the repo or create a branch if you have write access.
2. Make one focused, reviewable change.
3. Update related documentation and verify the behavior.
4. Open a PR explaining the problem, resulting behavior, checks, and limitations.
5. Address review feedback and wait for maintainer approval before merge.

## Development commands

Install Node.js 24.2 or newer and run `npm ci`. CI uses Node.js 24. The lockfile pins dependency versions; use `npm ci` for reproducible installs. Start dedicated Redis with `docker compose up -d --wait` before running tests. See the README for the full local development setup.

| Command                | Purpose                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `npm run dev`          | Start the local Worker on 127.0.0.1:8787.                         |
| `npm run check`        | Run all checks used by CI.                                        |
| `npm run typecheck`    | Generate Worker types and check strict TypeScript types.          |
| `npm test`             | Run tests in the local Worker runtime.                            |
| `npm run test:watch`   | Re-run tests as files change.                                     |
| `npm run format`       | Format source, configuration, and documentation.                  |
| `npm run format:check` | Check formatting without changing files.                          |
| `npm run build`        | Bundle into dist using Wrangler dry-run; no deployment.           |
| `npm run build:node`   | Build the standalone Node entry point.                            |
| `npm run start:local`  | Start the Node server using the ignored `.env` file.              |
| `npm run test:node`    | Test the Node listener and Redis flow outside the Worker runtime. |

Local development needs no hosted account or credentials. Tests use a dedicated Redis instance at `redis://127.0.0.1:6380` and start their own loopback HTTP bridge. To use a different local test port, set `REDIS_TEST_URL`; only loopback Redis is permitted. Never use a shared or production database. Tests delete only their own generated keys and never flush the database.

Worker tests load the Wrangler configuration with test bindings. Build output, local runtime state, credentials, and generated Worker types are ignored by Git. Run `npm run typegen` after changing Worker bindings or when setting up editor types; `npm run typecheck` does this automatically.

## Repository structure

- `src/index.ts`: Hono app and Worker entry point.
- `src/server.ts`, `src/node-server.ts`, and `src/node-config.ts`: standalone Node lifecycle, listener, and startup validation.
- `src/storage-controls.ts`: operator shutdown switches before body or storage work.
- `src/session-limits.ts` and `src/session-limit-script.ts`: validated allowances, safe rate-limit replies, and atomic expiring counters.
- `src/sessions.ts`: HTTP validation and session creation responses.
- `src/session-service.ts`: credential creation and bounded collision retries.
- `src/session-admission.ts` and `src/session-admission-script.ts`: global creation configuration, safe denials, and atomic pending/live capacity.
- `src/workload-budget.ts` and `src/workload-budget-script.ts`: atomic monthly Redis reservations and window validation.
- `src/workload-controls.ts`: operator budget configuration, operation weights, and bounded denial caching before storage.
- `src/tokens.ts`: random credentials and token digests.
- `src/body.ts`: bounded stream reading and request-body detection.
- `src/captures.ts`: capture HTTP validation and responses.
- `src/capture-input.ts`: input bounds, sensitive-header redaction, and binary encoding.
- `src/capture-store.ts`: live-session checks, atomic append, exact trimming, and fixed expiry.
- `src/event-reads.ts`: read HTTP validation and responses.
- `src/read-input.ts` and `src/read-auth.ts`: cursor/bearer validation and timing-safe authorization.
- `src/read-script.ts` and `src/read-store.ts`: atomic page selection, expiry rechecks, and byte bounds.
- `src/stored-event.ts`: stored schema validation and safe event reconstruction.
- `src/session-store.ts`: atomic Redis creation script and key layout.
- `src/redis.ts`: bounded HTTP transport with a timeout and no automatic write retries.
- `src/config.ts`: environment and origin validation.
- `test/worker.test.ts`: HTTP contract tests in the Worker runtime.
- `test-node/server.test.ts`: standalone startup and HTTP checks against dedicated Redis.
- `Dockerfile`: standalone image, with only runtime dependencies in the final stage.
- `test/sessions.test.ts` and `test/session-store.test.ts`: session behavior, storage, concurrency, and expiry tests.
- `scripts/redis-http.ts`: development/test bridge to a dedicated local Redis instance.
- `scripts/redis-http-handler.ts`: local bridge authentication and command validation.
- `wrangler.jsonc`: runtime entry point and compatibility settings.
- `vitest.config.ts` and `tsconfig.json`: test and type-check configuration.
- `.github/workflows/ci.yml`: read-only CI checks; no deployment secrets.
- `docs/`: design, roadmap, and maintainer documentation.

Keep the structure small; add files when a distinct responsibility needs them. Dependency versions are pinned, with Dependabot proposing reviewed updates.

## Code expectations

Use small named functions, explicit types, and straightforward control flow. Keep HTTP handling, security checks, and Redis operations easy to locate. Avoid dependencies and generic abstractions without a concrete need.

Give each function one responsibility. When a function mixes validation, storage, and response construction, extract those steps into named functions. Prefer named constants for limits and object arguments for related values. Keep helpers close to their callers; create a module when it owns a distinct responsibility. Readability matters more than an arbitrary line limit.

Explain security-sensitive invariants in comments. Test behavior that matters: expiry, concurrent writes, authorization, limits, and failures. Never commit credentials or enable logging of captured payloads.

## Review and conduct

Be respectful, explain disagreements, and give actionable feedback. Maintainers may close abusive discussions or restrict participation. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Contributions are licensed under MIT. No separate contributor agreement is required.
