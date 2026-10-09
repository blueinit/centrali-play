# Centrali Play

A small, disposable webhook capture API. Create a temporary session, send HTTP requests to its capture URL, and retrieve the captured requests as JSON.

**Early development:** the local Worker currently exposes a health endpoint. Session creation, capture, and event reads are not implemented. No hosted service is available.

## Purpose

Play gives someone testing webhook delivery an endpoint without requiring an account or their own receiver. It is API only; consumers provide their own viewer.

Play is designed to be a self-contained service that any application can use to test webhook delivery.

## Stack

- Strict TypeScript and Hono.
- Cloudflare Workers, npm, and Wrangler for development.
- Vitest in the local Worker runtime, TypeScript checking, and Prettier formatting.
- Redis for bounded storage and fixed expiry is planned; initial hosting targets Workers and Upstash free tiers.

Self-hosting is a planned path, not a supported capability today.

## Local development

Use Node.js 24 or newer (CI uses Node.js 24) and npm. No Cloudflare account, Redis server, or secrets are needed for the current skeleton.

```sh
git clone https://github.com/blueinit/centrali-play.git
cd centrali-play
npm ci
npm run dev
```

The server listens on `http://127.0.0.1:8787`. In another terminal:

```sh
curl -i http://127.0.0.1:8787/health
```

`GET /health` returns HTTP 200 with `{"status":"ok"}` and `Cache-Control: no-store`. This is a liveness check, not a database readiness check. Unknown routes and unsupported methods return HTTP 404 with `{"error":"not_found"}`. Stop the server with Ctrl+C.

## Checks

```sh
npm run check
```

This runs formatting checks, TypeScript checks, Worker-runtime tests, and a dry-run bundle. It does not deploy or create hosted resources.

Individual commands and repository structure are documented in [Contributing](CONTRIBUTING.md).

## Documentation

- [Design](docs/design.md): architecture, proposed API, and open decisions.
- [Roadmap](docs/roadmap.md): planned capabilities and release readiness.
- [Contributing](CONTRIBUTING.md): changes, code expectations, and review.
- [Maintaining](docs/maintaining.md): ownership, releases, deployment, and incidents.
- [Security](SECURITY.md): private reporting and data handling.

Do not send production secrets or personal data to a future hosted demo. Capture URLs and read tokens are sensitive capabilities.

## License

[MIT](LICENSE). Contributions use the same license.
