# Design

The standalone Node server and local Worker implement health checks, session creation, bounded capture, authorized event reads, per-session limits, global session admission, monthly workload budgets, and operator shutdown switches. API details and limits may change before the first release.

## Architecture

- API-only webhook receiver; clients provide their own viewer.
- TypeScript and Hono, with standalone Node operation and local Worker compatibility tests.
- Redis storage through Upstash's HTTP interface; native TCP support remains planned.
- Self-contained deployment with dedicated storage and credentials.
- Fixed lifetime, bounded captures, and abuse controls.

## Proposed API and defaults

The [session contract](sessions.md) specifies the creation response, token format, fixed lifetime, and public URL configuration.

The [capture contract](capture.md) defines implemented input limits, binary encoding, sensitive-header redaction, method handling, and atomic storage.

The [event-read contract](reads.md) defines bearer authorization, exclusive cursors, retention warnings, bounded pages, and polling backoff.

The [abuse-control contract](abuse-controls.md) defines implemented shutdown switches, session admission/limits, and workload/transfer budgets, plus proposed edge guards, client identity, and privacy rules.

| Operation                    | Purpose                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `POST /sessions`             | Return a session ID, capture URL, separate read token, and expiry. |
| `ANY /capture/:captureToken` | Capture an unsigned request for a live session.                    |
| `GET /sessions/:id/events`   | Read events with a bearer read token.                              |
| `GET /health`                | Report application health without secrets.                         |

Health, session creation, capture, and event reads are available locally. Health returns `{"status":"ok"}` with HTTP 200 and checks liveness only. All operations disable caching. Unknown routes return JSON 404 responses. Capture supports GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS; reads support GET and HEAD. Unsupported capture/read methods return 405. HEAD returns headers without a response body.

Implemented limits include a one-hour lifetime, latest 50 events, 64 KiB bodies, per-session capture/read limits, global creation/capacity limits, and [monthly workload budgets](workload-budgets.md). The capture contract specifies header/query limits and base64 body encoding. Read pages contain up to 10 events and 256 KiB. Edge guards remain planned.

Capture tokens must not authorize reads. IDs are identifiers, not credentials. Tokens must be cryptographically random. Session creation and read responses must disable caching.

Cursor reads return only events newer than the supplied cursor. The read contract defines trimming warnings, polling backoff, expiry stop conditions, and HEAD/OPTIONS behavior. No CORS allow headers are added yet.

## Redis invariants

- Metadata and captures share the same absolute deadline; activity never extends it.
- Capture validation, append, and trim are atomic. Expired sessions cannot be resurrected.
- Reads reject expired sessions even before physical cleanup completes.
- Success means persistence succeeded; Redis failure must not return false success.

Keep ordinary Redis operations behind a small adapter. Upstash HTTP is the first connection path. A self-hosted TCP adapter may follow; test portability before advertising support.

## Security and quotas

Limit creation, capture, and reads. Reject malformed tokens and oversized input before unnecessary database work. Enforce streamed body size, not only Content-Length.

Cloudflare-native rate limits are approximate and local to an edge location. The abuse-control proposal combines them with strict Redis admission and session counters. Application workload allowances are distinct from provider billing limits.

Define trusted proxy IP handling for each deployment; never trust arbitrary caller forwarding headers. CORS is not authentication. Return captures as JSON with explicit body encoding, never executable HTML. Capture redacts common credential headers as specified in its contract.

Measure Redis commands and bandwidth for a full session including empty polling. Free quotas mean bounded availability, not unlimited scale. Operators should budget for storage and bandwidth as well as commands, and configure spending limits where supported.

## References

- [Hono on Workers](https://hono.dev/docs/getting-started/cloudflare-workers)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Upstash pricing](https://upstash.com/pricing/redis)
- [Upstash REST API](https://upstash.com/docs/redis/features/restapi)
