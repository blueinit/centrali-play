# Maintaining Play

## Ownership and review

Initial maintainer: [@buildwithmary](https://github.com/buildwithmary). CODEOWNERS requests their review. Add maintainers through reviewed changes and grant minimal access.

All changes use PRs. Keep changes focused and reviewable. Squash merges are enabled; merged branches are automatically deleted. Review all code for correctness, maintainability, and security regardless of how it was authored.

Main protection requires PRs and the `Check` CI job on an up-to-date branch, blocks deletion and force pushes, and applies to administrators. Required approving reviews are currently zero because there is one maintainer; human approval is an explicit workflow requirement rather than a GitHub-enforced review count. CODEOWNERS requests review but does not enforce it. Require approving reviews when another maintainer joins.

GitHub does not allow authors to approve their own PRs. Maintainer-authored PRs need another reviewer or documented self-review where only one maintainer is available.

Private vulnerability reporting and dependency alerts are enabled. Dependabot checks npm dependencies and GitHub Actions weekly. Review advisories, lockfiles, install scripts, and pinned action updates. CI uses read-only repository permissions and does not deploy.

## Releases

No release or deployment exists. The [standalone runtime guide](running.md) covers Node/Docker operation with Upstash. Before `v0.1.0`, verify clean-checkout setup, expiry/concurrency, authorization, limits, backend failures, safe logs, and realistic polling costs. Finalize API documentation and supported versions.

For routine PRs, run `npm ci`, `docker compose up -d --wait`, and `npm run check` from a clean checkout. A successful dry-run bundle is not approval to deploy. Both runtimes support bounded capture, authorized reads, per-session limits, global session admission, and operator shutdown switches, but global workload budgets remain unimplemented. Keep instances private; public Worker and preview URLs are disabled in configuration.

Use semantic version tags and release notes explaining behavior, compatibility, and known limitations. Announce breaking API changes explicitly, including before 1.0.

## Deployment and spending

The app can run on Node/Docker with Upstash Redis. A local Worker harness verifies runtime compatibility; host-specific production infrastructure belongs to operator deployment configuration. Operators choose plans appropriate to their traffic and availability requirements. Prefer local tests; keep hosted test and production credentials separate.

Store credentials in platform secrets, never Git, fixtures, screenshots, or logs. A reviewed deployment workflow must use minimal permissions, pinned action commits, and a production approval gate. Untrusted fork PRs must not receive secrets.

Before launch, document exact provisioning, deploy, disable, rollback, and quota-check commands and verify them. Record resource ownership and quota dashboards. Check usage after releases and traffic increases. Redis budgets include all provider charges; Workers costs are separate. Recheck plan behavior before relying on a cap.

## Incidents

### Storage shutdown switches

Set `DISABLE_SESSION_CREATION=true` to pause new sessions while existing sessions can still capture and read. Set `DISABLE_STORAGE_ROUTES=true` to stop creation, capture, and reads. These are operator environment bindings; callers cannot select them through headers or query parameters. Local development can set them in `.dev.vars` and restart the Worker. Hosted update commands must be verified in the launch runbook before deployment.

Both switches accept only the strings `true` and `false`. An omitted switch defaults to `false` for the current local-development stage. Any other value fails closed on all storage routes. These switches do not enable public deployment or replace the protected profile and admission controls still required before launch.

Shutdown takes precedence over route input validation. A stopped route returns a safe 503, `Cache-Control: no-store`, and `Retry-After: 60` before reading a body or contacting Redis. HEAD responses are bodyless. Health checks and unknown routes retain their usual behavior. Shutdown does not delete sessions or extend their expiry; requests already in flight may finish, and clients may retry after recovery.

For abuse or quota exhaustion, disable storage routes or the deployment as needed to protect resource limits. Changing environment bindings takes effect when the updated Worker configuration becomes active; this is not an instantaneous cancellation mechanism. Restore switches to `false` only after investigating and verifying recovery.

For leaked credentials, revoke and rotate first, then investigate privately. Deleting a secret from a commit does not revoke it or erase history.

For faulty releases, restore the last verified deployment and prepare a tested fix. Record impact, cause, response, and prevention without publishing payloads or exploitable details prematurely.
