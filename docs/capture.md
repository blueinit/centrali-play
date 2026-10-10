# Capture contract

Capture and [event reads](reads.md) are implemented for local development. Public deployment also requires the abuse controls described in the [design](design.md).

## Request and response

`/capture/<capture-token>` accepts requests for a live session using the independently generated capture capability. Validate the token as exactly 64 lowercase hexadecimal characters before storage access. A session ID or read token does not authorize capture.

Accept GET, POST, PUT, PATCH, DELETE, HEAD, and OPTIONS. HEAD is captured but its response has no body. OPTIONS is captured as an ordinary request; this stage does not enable browser cross-origin access or return CORS allow headers. Other methods return 405 with an `Allow` header. The platform may reject requests before they reach the Worker.

Return 204 with `Cache-Control: no-store` only after Redis confirms persistence. Do not echo the request or return credentials. An empty body is a valid capture.

| Status | JSON error code       | Meaning                                                          |
| ------ | --------------------- | ---------------------------------------------------------------- |
| 404    | `not_found`           | Malformed, unknown, or expired capture capability.               |
| 405    | `method_not_allowed`  | Unsupported method.                                              |
| 413    | `payload_too_large`   | A body, header, or query limit was exceeded.                     |
| 408    | `request_timeout`     | The body did not finish within the read deadline.                |
| 400    | `invalid_request`     | The request stream failed.                                       |
| 429    | `rate_limited`        | The session's minute or lifetime capture allowance is exhausted. |
| 503    | `service_unavailable` | Storage failed or the write result is uncertain.                 |

Errors disable caching and include no request content, credentials, or backend details. HEAD responses have no body, including errors. The [per-session limits](session-limits.md) define minute/lifetime admission, fixed counter expiry, and `Retry-After` on 429 responses. Denied captures do not append or refresh event storage.

## Bounded input

Use named constants for these initial limits:

| Input              | Limit                                                        |
| ------------------ | ------------------------------------------------------------ |
| Raw body           | 65,536 bytes (64 KiB).                                       |
| Body read deadline | Five seconds from starting to consume the stream.            |
| Headers            | 64 entries and 16,384 total UTF-8 bytes of names and values. |
| Query string       | 4,096 UTF-8 bytes, including the leading `?`.                |
| Stored events      | Latest 50 per session.                                       |

Enforce the body limit while reading chunks; Content-Length is only an optional early rejection hint. Cancel reading when a limit or deadline is reached, without waiting indefinitely for cancellation. Reject oversized input rather than silently truncate it. Validate the capability and confirm a live session before buffering the body; the final storage operation must independently recheck liveness.

Count all headers toward limits before redaction. Capture the headers exposed by the Worker Fetch API; original wire casing, order, and duplicate boundaries are not guaranteed. Omit `authorization`, `proxy-authorization`, `cookie`, and `set-cookie`, case-insensitively. Keep other headers in lowercase name/value pairs. Application-specific secrets in other headers, queries, or bodies remain visible to anyone with read access; use synthetic data and temporary test credentials.

## Stored event

Each accepted request stores a versioned JSON payload in the stream's `event` field and a Redis timestamp in its `receivedAt` field. Keeping the original JSON avoids changing empty arrays during Lua encoding. The read API combines those fields with the stream ID into this event shape:

| Field        | Representation                                                                    |
| ------------ | --------------------------------------------------------------------------------- |
| `version`    | Integer `1`.                                                                      |
| `id`         | Redis stream ID assigned atomically during append; used as the read cursor.       |
| `receivedAt` | Integer Unix milliseconds derived from Redis time at append.                      |
| `method`     | Request method.                                                                   |
| `query`      | Encoded query string, including `?`, or an empty string.                          |
| `headers`    | Array of `[name, value]` pairs after redaction.                                   |
| `body`       | `{ "encoding": "base64", "data": "…", "byteLength": 0 }`, with the actual length. |

Store body bytes as base64 regardless of Content-Type. This preserves binary and invalid UTF-8 input without guessing or parsing user content. The base64 expansion is bounded by the raw body limit. Future reads must return captures as JSON, never executable HTML.

Do not store the full capture URL, capture token, read token, caller IP, or caller-supplied forwarding headers as trusted identity. Forwarding headers may appear among captured headers but have no security authority. The stream supplies the event ID; it need not be duplicated inside the stored JSON payload. Queries can contain sensitive data and must never enter application logs.

## Atomic storage and expiry

Use `play:events:<session-id>` as the Redis stream key. In one bounded Lua operation, check the capture lookup, session metadata, and fixed deadline against Redis time; append the event; trim exactly to the latest 50 entries; and attach the session's original absolute expiry. Do not use approximate trimming, since 50 is a storage bound.

An expired or missing session must never create or recreate an event stream. Every accepted event shares the session deadline; writes never extend retention. A session with no captures needs no event key. Keep the existing session creation key layout unchanged.

Redis script execution prevents interleaving but does not roll back commands after an error. Arrange validation before mutation, attach expiry during the append operation's guarded sequence, and test failure handling so a partial write cannot leave permanent data. Only return success after the complete script succeeds. Do not automatically retry uncertain writes: a retry can create a duplicate. Sender retries are separate captures; this endpoint makes no exactly-once guarantee.

The implementation uses exact [XADD trimming](https://redis.io/docs/latest/commands/xadd/) and [EXPIREAT](https://redis.io/docs/latest/commands/expireat/) in the same script. If expiry attachment fails, the script deletes the event stream and returns an error. This deliberately discards the session's captures rather than retain data without a deadline. Operators must grant all required script commands, including cleanup with `DEL`; provider permissions and compatibility must be checked before launch.

A successful capture uses three Redis HTTP calls: capture lookup, live-session validation, and the final atomic append. The body is consumed only after the live-session check. Header and query bounds are checked before database access. Redis reply limits remain 4 KiB because capture returns only an ID internally, not the captured payload.

The local development bridge permits commands up to 256 KiB to accommodate a bounded base64 body, headers, and the script. It remains loopback-only development tooling.

## Implementation and verification

Keep the HTTP handler, bounded input/encoding, and storage script in focused modules. Reuse the credential digest and configuration helpers. Keep creation behavior unchanged.

Tests must cover binary and empty bodies; the exact body boundary; streamed overflow and stalled input; header and query boundaries; redaction; supported methods including HEAD and OPTIONS; malformed credentials before storage access; unknown and expired credentials; safe backend failures; and no success on uncertain writes.

Real Redis tests must cover concurrent appends, exact trimming, shared expiry, and expiry between the initial lookup and final append. Verify that rejected writes cannot resurrect a session and that storage failures cannot leave an event key without expiry. Hosted Upstash compatibility remains a launch check.
