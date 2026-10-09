# Maintaining Play

## Ownership and review

Initial maintainer: [@buildwithmary](https://github.com/buildwithmary). CODEOWNERS requests their review. Add maintainers through reviewed changes and grant minimal access.

All changes use PRs. Keep changes focused and reviewable. Squash merges are enabled; merged branches are automatically deleted. Review all code for correctness, maintainability, and security regardless of how it was authored.

Main protection requires PRs and the `Check` CI job on an up-to-date branch, blocks deletion and force pushes, and applies to administrators. Required approving reviews are currently zero because there is one maintainer; human approval is an explicit workflow requirement rather than a GitHub-enforced review count. CODEOWNERS requests review but does not enforce it. Require approving reviews when another maintainer joins.

GitHub does not allow authors to approve their own PRs. Maintainer-authored PRs need another reviewer or documented self-review where only one maintainer is available.

Private vulnerability reporting and dependency alerts are enabled. Dependabot checks npm dependencies and GitHub Actions weekly. Review advisories, lockfiles, install scripts, and pinned action updates. CI uses read-only repository permissions and does not deploy.

## Releases

No release or deployment exists. Before `v0.1.0`, verify clean-checkout setup, expiry/concurrency, authorization, limits, backend failures, safe logs, and realistic polling costs. Finalize API documentation and supported versions.

For routine PRs, run `npm ci`, `docker compose up -d --wait`, and `npm run check` from a clean checkout. A successful dry-run bundle is not approval to deploy. The current Worker has no capture or abuse controls and is intended for local development only; public Worker and preview URLs are disabled in configuration.

Use semantic version tags and release notes explaining behavior, compatibility, and known limitations. Announce breaking API changes explicitly, including before 1.0.

## Deployment and spending

The initial deployment target is Workers with Upstash Redis. Operators choose plans appropriate to their traffic and availability requirements. Prefer local tests; keep hosted test and production credentials separate.

Store credentials in platform secrets, never Git, fixtures, screenshots, or logs. A reviewed deployment workflow must use minimal permissions, pinned action commits, and a production approval gate. Untrusted fork PRs must not receive secrets.

Before launch, document exact provisioning, deploy, disable, rollback, and quota-check commands and verify them. Record resource ownership and quota dashboards. Check usage after releases and traffic increases. Redis budgets include all provider charges; Workers costs are separate. Recheck plan behavior before relying on a cap.

## Incidents

For abuse or quota exhaustion, disable creation or the deployment as needed to protect data and resource limits.

For leaked credentials, revoke and rotate first, then investigate privately. Deleting a secret from a commit does not revoke it or erase history.

For faulty releases, restore the last verified deployment and prepare a tested fix. Record impact, cause, response, and prevention without publishing payloads or exploitable details prematurely.
