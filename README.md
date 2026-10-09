# Centrali Play

A small, disposable webhook capture API. Create a temporary session, send HTTP requests to its capture URL, and retrieve the captured requests as JSON.

**Early development:** there is no deployed service or implemented API yet. Setup commands and examples will arrive with working code.

## Purpose

Play gives someone testing webhook delivery an endpoint without requiring an account or their own receiver. It is API only; consumers provide their own viewer.

Play is designed to be a self-contained service that any application can use to test webhook delivery.

## Planned stack

- Strict TypeScript and Hono.
- Redis for bounded capture storage and fixed expiry.
- Cloudflare Workers Free and Upstash Redis Free for initial hosting.
- npm and Wrangler for development; automated checks added with the first code.

Self-hosting is a planned path, not a supported capability today.

## Documentation

- [Design](docs/design.md): architecture, proposed API, and open decisions.
- [Roadmap](docs/roadmap.md): planned capabilities and release readiness.
- [Contributing](CONTRIBUTING.md): changes, code expectations, and review.
- [Maintaining](docs/maintaining.md): ownership, releases, deployment, and incidents.
- [Security](SECURITY.md): private reporting and data handling.

Do not send production secrets or personal data to a future hosted demo. Capture URLs and read tokens are sensitive capabilities.

## License

[MIT](LICENSE). Contributions use the same license.
