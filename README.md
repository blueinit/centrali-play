# Centrali Play

A small, disposable webhook capture API. Create a temporary session, send HTTP requests to its capture URL, and retrieve the captured requests as JSON.

**Early development:** health checks, session creation, bounded capture, authorized event reads, and operator shutdown switches work locally. No hosted service is available; public deployment awaits admission limits and the remaining abuse controls.

## Purpose

Play gives someone testing webhook delivery an endpoint without requiring an account or their own receiver. It is API only; consumers provide their own viewer.

Play is designed to be a self-contained service that any application can use to test webhook delivery.

## Stack

- Strict TypeScript and Hono.
- Cloudflare Workers, npm, and Wrangler for development.
- Vitest in the local Worker runtime, TypeScript checking, and Prettier formatting.
- Redis stores session metadata and credentials with fixed expiry; initial hosting targets Workers and Upstash free tiers.

Self-hosting is a planned path, not a supported capability today.

## Local development

Use Node.js 24.2 or newer (CI uses Node.js 24), npm, and Docker with Compose. No Cloudflare or Upstash account is needed for local development.

```sh
git clone https://github.com/blueinit/centrali-play.git
cd centrali-play
npm ci
docker compose up -d --wait
cp .dev.vars.example .dev.vars
npm run dev:redis
```

This starts a loopback-only HTTP bridge to the dedicated development Redis instance on port 6380. Keep that terminal open, then start the Worker in another terminal:

```sh
npm run dev
```

The server listens on `http://127.0.0.1:8787`. In another terminal:

```sh
curl -i http://127.0.0.1:8787/health
curl -i -X POST http://127.0.0.1:8787/sessions
```

`GET /health` returns HTTP 200 with `{"status":"ok"}`. This is a liveness check, not a database readiness check. `POST /sessions` returns HTTP 201 with an ID, capture URL, read token, and fixed expiry, as described in the [session contract](docs/sessions.md). Both responses disable caching.

Copy the returned capture URL into this command using synthetic data:

```sh
curl -i -X POST '<captureUrl>' \
  -H 'Content-Type: application/json' \
  --data '{"example":"hello"}'
```

A successful capture returns 204 after storage confirms the write. Bodies are limited to 64 KiB, common credential headers are redacted, and the latest 50 events share the session deadline. See the [capture contract](docs/capture.md) for all limits and methods.

Use the session ID and separate read token from creation to retrieve captures:

```sh
curl 'http://127.0.0.1:8787/sessions/<session-id>/events?after=0-0' \
  -H 'Authorization: Bearer <read-token>'
```

The JSON response contains base64 bodies and a `nextCursor`. Pass that cursor as `after` on the next request to read only newer events. Pages contain up to 10 events within a 256 KiB response limit. Follow `hasMore` for additional pages; back off between empty polls as described in the [read contract](docs/reads.md). Reads never extend expiry. Unknown routes return JSON 404 responses; unsupported capture and read methods return 405.

Stop the Worker and bridge with Ctrl+C, then run `docker compose down`. Development Redis has no persistent volume; removing its container discards its data.

The HTTP bridge is development tooling, not a production Redis gateway. It accepts Redis commands using a public placeholder token. Never expose it, use production credentials with it, or point it at application data.

## Checks

```sh
docker compose up -d --wait
npm run check
```

This runs formatting checks, TypeScript checks, tests against local Redis in the Worker runtime, and a dry-run bundle. Tests start and stop their own HTTP bridge; `npm run dev:redis` is not required for them. It does not deploy or create hosted resources.

Individual commands and repository structure are documented in [Contributing](CONTRIBUTING.md).

## Documentation

- [Design](docs/design.md): architecture, proposed API, and open decisions.
- [Session contract](docs/sessions.md): creation response, credentials, expiry, and configuration.
- [Capture contract](docs/capture.md): methods, limits, redaction, binary encoding, and storage.
- [Event-read contract](docs/reads.md): authorization, cursor pagination, response bounds, and polling.
- [Abuse-control contract](docs/abuse-controls.md): implemented shutdown switches and proposed rate limits, global budgets, and privacy rules.
- [Roadmap](docs/roadmap.md): planned capabilities and release readiness.
- [Contributing](CONTRIBUTING.md): changes, code expectations, and review.
- [Maintaining](docs/maintaining.md): ownership, releases, deployment, and incidents.
- [Security](SECURITY.md): private reporting and data handling.

Do not send production secrets or personal data to a future hosted demo. Capture URLs and read tokens are sensitive capabilities.

## License

[MIT](LICENSE). Contributions use the same license.
