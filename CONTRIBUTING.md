# Contributing

Read the [design](docs/design.md) and [roadmap](docs/roadmap.md) first. Discuss substantial API or architecture changes in an issue before implementation. Use synthetic examples; never include credentials or captured production data.

## Workflow

1. Fork the repo or create a branch if you have write access.
2. Make one focused, reviewable change.
3. Update related documentation and verify the behavior.
4. Open a PR explaining the problem, resulting behavior, checks, and limitations.
5. Address review feedback and wait for maintainer approval before merge.

There is no runnable application or test suite yet. The first code PR must supply tested setup and check commands.

## Code expectations

Use small named functions, explicit types, and straightforward control flow. Keep HTTP handling, security checks, and Redis operations easy to locate. Avoid dependencies and generic abstractions without a concrete need.

Explain security-sensitive invariants in comments. Test behavior that matters: expiry, concurrent writes, authorization, limits, and failures. Never commit credentials or enable logging of captured payloads.

## Review and conduct

Be respectful, explain disagreements, and give actionable feedback. Maintainers may close abusive discussions or restrict participation. Report vulnerabilities privately through [SECURITY.md](SECURITY.md).

Contributions are licensed under MIT. No separate contributor agreement is required.
