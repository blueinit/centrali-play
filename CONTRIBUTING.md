# Contributing

Read the [design](docs/design.md) and [roadmap](docs/roadmap.md) first. Discuss substantial API or architecture changes in an issue before implementation. Use synthetic examples; never include credentials or captured production data.

## Workflow

1. Fork the repo or create a branch if you have write access.
2. Make one focused, reviewable change.
3. Update related documentation and verify the behavior.
4. Open a PR explaining the problem, resulting behavior, checks, and limitations.
5. Address review feedback and wait for maintainer approval before merge.

## Development commands

Install Node.js 24 or newer and run `npm ci`. CI uses Node.js 24. The lockfile pins dependency versions; use `npm ci` for reproducible installs.

| Command                | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Start the local Worker on 127.0.0.1:8787.                |
| `npm run check`        | Run all checks used by CI.                               |
| `npm run typecheck`    | Generate Worker types and check strict TypeScript types. |
| `npm test`             | Run tests in the local Worker runtime.                   |
| `npm run test:watch`   | Re-run tests as files change.                            |
| `npm run format`       | Format source, configuration, and documentation.         |
| `npm run format:check` | Check formatting without changing files.                 |
| `npm run build`        | Bundle into dist using Wrangler dry-run; no deployment.  |

The current skeleton needs no account, secrets, or database. Tests load the same Wrangler configuration as local development. Build output, local runtime state, and generated Worker types are ignored by Git. Run `npm run typegen` after changing Worker bindings or when setting up editor types; `npm run typecheck` does this automatically.

## Repository structure

- `src/index.ts`: Hono app and Worker entry point.
- `test/worker.test.ts`: HTTP contract tests in the Worker runtime.
- `wrangler.jsonc`: runtime entry point and compatibility settings.
- `vitest.config.ts` and `tsconfig.json`: test and type-check configuration.
- `.github/workflows/ci.yml`: read-only CI checks; no deployment secrets.
- `docs/`: design, roadmap, and maintainer documentation.

Keep the structure small; add files when a distinct responsibility needs them. Dependency versions are pinned, with Dependabot proposing reviewed updates.

## Code expectations

Use small named functions, explicit types, and straightforward control flow. Keep HTTP handling, security checks, and Redis operations easy to locate. Avoid dependencies and generic abstractions without a concrete need.

Explain security-sensitive invariants in comments. Test behavior that matters: expiry, concurrent writes, authorization, limits, and failures. Never commit credentials or enable logging of captured payloads.

## Review and conduct

Be respectful, explain disagreements, and give actionable feedback. Maintainers may close abusive discussions or restrict participation. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Contributions are licensed under MIT. No separate contributor agreement is required.
