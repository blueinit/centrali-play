# Design

Only the local Worker skeleton and health endpoint are implemented. This document describes the intended capture architecture; API details and limits may change before the first release.

## Architecture

- API-only webhook receiver; clients provide their own viewer.
- TypeScript and Hono on Workers, Redis storage, Upstash for initial hosting.
- Self-contained deployment with dedicated storage and credentials.
- Fixed lifetime, bounded captures, and abuse controls.

## Proposed API and defaults

| Operation                    | Purpose                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `POST /sessions`             | Return a session ID, capture URL, separate read token, and expiry. |
| `ANY /capture/:captureToken` | Capture an unsigned request for a live session.                    |
| `GET /sessions/:id/events`   | Read events with a bearer read token.                              |
| `GET /health`                | Report application health without secrets.                         |

Only `GET /health` is available today. It returns `{"status":"ok"}` with HTTP 200 and `Cache-Control: no-store`. It checks liveness only. Other routes return JSON 404 responses. Hono also handles HEAD for GET routes, returning headers without a response body.

Proposed limits: one-hour lifetime, latest 50 events, 64 KiB bodies. Header limits, rate limits, binary body encoding, and response limits remain open.

Capture tokens must not authorize reads. IDs are identifiers, not credentials. Tokens must be cryptographically random. Session creation and read responses must disable caching.

Cursor reads should return only new events. Specify behavior when old events are trimmed, polling backoff, and a stop condition. Define HEAD, OPTIONS, and CORS preflight behavior explicitly.

## Redis invariants

- Metadata and captures share the same absolute deadline; activity never extends it.
- Capture validation, append, and trim are atomic. Expired sessions cannot be resurrected.
- Reads reject expired sessions even before physical cleanup completes.
- Success means persistence succeeded; Redis failure must not return false success.

Keep ordinary Redis operations behind a small adapter. Upstash HTTP is the first connection path. A self-hosted TCP adapter may follow; test portability before advertising support.

## Security and quotas

Limit creation, capture, and reads. Reject malformed tokens and oversized input before unnecessary database work. Enforce streamed body size, not only Content-Length.

Cloudflare-native rate limits are approximate and local to an edge location. Use them as an outer guard; enforce strict session storage invariants in Redis. Exact rate enforcement and quota protection remain to be specified.

Define trusted proxy IP handling for each deployment; never trust arbitrary caller forwarding headers. CORS is not authentication. Return captures as JSON with explicit body encoding, never executable HTML. Decide sensitive-header redaction before capture implementation.

Measure Redis commands and bandwidth for a full session including empty polling. Free quotas mean bounded availability, not unlimited scale. Operators should budget for storage and bandwidth as well as commands, and configure spending limits where supported.

## References

- [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Upstash pricing](https://upstash.com/pricing/redis)
- [Upstash REST API](https://upstash.com/docs/redis/features/restapi)
