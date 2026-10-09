# Session contract

Session creation, [capture](capture.md), and [event reads](reads.md) are implemented for local development. Public deployment requires creation-rate limits and other abuse controls first.

## Create a session

`POST /sessions` creates an anonymous, temporary capture destination. It requires no account or authorization header. The request has no body or configuration fields; clients cannot choose tokens, extend retention, or change storage limits.

```sh
curl -X POST https://play.example/sessions
```

Success returns HTTP 201, `Content-Type: application/json`, and `Cache-Control: no-store`:

```json
{
  "id": "<session-id>",
  "captureUrl": "https://play.example/capture/<capture-token>",
  "readToken": "<read-token>",
  "expiresAt": "2026-10-09T20:00:00Z"
}
```

The hostname and angle-bracket values above are placeholders. `expiresAt` is a UTC timestamp in RFC 3339 format.

| Field        | Meaning                                                                      |
| ------------ | ---------------------------------------------------------------------------- |
| `id`         | Public identifier used in the event-read path. It does not authorize access. |
| `captureUrl` | Full URL that a webhook sender can call. Possession permits capture only.    |
| `readToken`  | Secret bearer credential that permits reading this session's events.         |
| `expiresAt`  | Fixed deadline for the session and all its captures.                         |

Creation returns the credentials once. There is no token recovery, rotation, or session renewal API in the initial version. A caller who loses credentials creates a new session.

## Capture and read capabilities

A capture token never authorizes event reads. A read token never authorizes writes to a capture endpoint. The session ID alone authorizes neither operation. These are separate capabilities, not user accounts.

Clients can give the capture URL to a webhook sender while keeping the read token private. Anyone who obtains the read token and session ID can read the session until expiry. Anyone who obtains the capture URL can inject events until expiry, subject to limits.

The read request is:

```sh
curl https://play.example/sessions/<session-id>/events \
  -H 'Authorization: Bearer <read-token>'
```

Never put read tokens in query strings. Clients should keep them in memory, avoid analytics and logs, and discard them when the session expires. They should not embed read tokens in public pages or shared URLs.

## Token generation and storage

- Session IDs: 16 random bytes, encoded as 32 lowercase hexadecimal characters.
- Capture and read tokens: independently generated 32 random bytes each, encoded as 64 lowercase hexadecimal characters.
- Generate all values using the runtime's cryptographically secure random generator.
- Persist SHA-256 token digests instead of raw tokens. Use the capture digest for lookup and the read digest for authorization.
- Reject malformed identifiers and tokens before storage access. Use a comparison appropriate for secret digests when validating read authorization.

Hashes do not make capture URLs safe to disclose. Platform access logs, client logs, and screenshots can still expose their raw values. Stored digests reduce credential exposure if storage is inspected; they do not protect captured payloads from someone with database access.

## Expiry and atomic creation

The initial lifetime is 3,600 seconds. The storage operation establishes one absolute deadline. Metadata, the capture-token lookup, and capture storage all expire at that deadline. Creating no events must not leave a permanent lookup key.

All creation writes must succeed atomically. A collision must never overwrite an existing session; generate fresh values and retry only a bounded number of times. Activity and reads never move the deadline. Later capture operations must atomically check the session's deadline before writing so an expired session cannot be recreated by a racing request.

Return HTTP 201 only after storage confirms creation. If the storage result is uncertain, return a failure rather than claiming success. A timed-out creation may leave a session that the caller never received; its fixed TTL still removes it. Creation is not idempotent: retrying can create another session.

Physical expiry depends on the storage provider. The API must deny access at the deadline even if expired data has not yet been physically reclaimed.

## Public URL configuration

Operators configure `PUBLIC_BASE_URL` as a single origin: scheme and hostname, with an optional port. Paths, query strings, fragments, and embedded credentials are invalid. Require HTTPS except for HTTP loopback addresses used in local development.

Build capture URLs from this validated configuration. Do not derive them from `Host`, `Forwarded`, or `X-Forwarded-Host` supplied by a caller. Invalid or missing configuration must fail creation safely, without returning a usable-looking URL.

## Creation errors

Errors use JSON with a stable error code and `Cache-Control: no-store`. Responses do not include request content, credentials, storage details, or stack traces.

| Status | Body                              | Meaning                                                                           |
| ------ | --------------------------------- | --------------------------------------------------------------------------------- |
| 400    | `{"error":"invalid_request"}`     | The request contains an unexpected body.                                          |
| 429    | `{"error":"rate_limited"}`        | The caller has exceeded creation limits. Include `Retry-After`.                   |
| 503    | `{"error":"service_unavailable"}` | Storage is unavailable, quotas are exhausted, or configuration prevents creation. |

The server detects an unexpected body without buffering an unbounded request. Creation-rate thresholds and the precise quota-exhaustion behavior will be documented with abuse controls. The 429 response is reserved for those controls and is not implemented yet. Backend failures, including backend quota errors, currently return 503. Session creation must not be publicly deployed before abuse controls exist.

## Storage and configuration

The current store creates two expiring string keys:

- `play:session:<id>`: JSON containing the ID, token digests, and integer expiry in Unix seconds.
- `play:capture:<capture-token-digest>`: the session ID, allowing capture lookup without persisting raw tokens.

The Lua script uses Redis server time for its deadline. It checks both keys before writing and attaches expiry to each write. A failed second write removes the first. Only confirmed collisions are retried, at most three attempts with fresh credentials.

The HTTP transport sends commands in POST bodies with a bearer credential. It refuses redirects, times out after five seconds, bounds creation/capture responses to 4 KiB, and does not automatically retry uncertain writes. Event reads have a separate 256 KiB reply policy, as described in the read contract.

Required environment values are `PUBLIC_BASE_URL`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN`. Both URLs must be origins satisfying the origin rules above. For hosted use, the Redis token must be a write-capable secret from the database provider. The checked-in `.dev.vars.example` uses a public development placeholder for the local bridge; it is not a hosted credential.

Local Redis tests verify the script and HTTP flow. Upstash REST compatibility still requires a hosted smoke test before release; local testing does not verify provider-specific quotas or billing. Redis Cluster support is not verified.

## Verification requirements

- Returned identifiers and tokens have the documented format and are generated independently.
- Responses use the configured origin despite caller-supplied host headers.
- Invalid public origins and unexpected bodies fail safely.
- Storage contains digests, not raw tokens; response caching is disabled.
- Metadata and capture lookup share a fixed expiry, including sessions with no events.
- Concurrent creation or token collisions cannot overwrite another session.
- Backend failures do not return successful-looking credentials.
- Real Redis tests verify atomic writes and expiry; mocked responses alone are insufficient.

Capture writes and event reads have their own behavior and real Redis tests. Abuse limits need their own behavior tests when implemented.
