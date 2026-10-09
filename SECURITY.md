# Security

## Reporting vulnerabilities

Use [GitHub private vulnerability reporting](https://github.com/blueinit/centrali-play/security/advisories/new), which is enabled for this repo. Do not publish exploit details or secrets in issues or PRs.

Include affected code or version, reproduction steps using synthetic data, expected and observed behavior, and impact. Maintainers will investigate privately and coordinate disclosure. No paid bounty or guaranteed response time is offered.

## Supported versions

No release exists. During early development, fixes target main. A supported-version policy will accompany the first release.

## Data handling

Play is for temporary test payloads. Do not send production secrets or personal data. The proposed design separates capture and read capabilities.

The implementation must not log bodies, authorization headers, tokens, or full capability URLs. TTL bounds live Redis retention and application access; it does not guarantee simultaneous deletion from provider logs or backups.

Run capture services with dedicated credentials and isolated storage. Do not grant them access to unrelated application data or infrastructure.
