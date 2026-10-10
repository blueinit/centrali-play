# Event-read contract

Event reads are implemented for local development. Public deployment also requires abuse controls and hosted compatibility checks.

## Request and authorization

```sh
curl 'https://play.example/sessions/<session-id>/events?after=0-0' \
  -H 'Authorization: Bearer <read-token>'
```

Support GET and HEAD. Other methods return 405 with `Allow: GET, HEAD`. OPTIONS does not enable CORS. GET accepts no body; reject unexpected, failed, or stalled bodies with 400 without unbounded buffering. HEAD performs the same input validation and live-session authorization but returns no body and need not load events.

Session IDs must be exactly 32 lowercase hexadecimal characters. Read tokens must be exactly 64 lowercase hexadecimal characters in a single bearer authorization header. The bearer scheme is case-insensitive; reject multiple credentials or extra token fields. Never accept credentials from query parameters, cookies, or the capture URL. Reject malformed identifiers and credentials before database access.

Hash the supplied read token and compare fixed-length digest bytes using the Worker runtime's timing-safe comparison primitive. The session ID alone, a capture token, and another session's read token must never permit reads.

Use one safe 404 response for unknown sessions, expired sessions, and well-formed but incorrect read credentials. Missing or malformed bearer credentials return 401 with `WWW-Authenticate: Bearer realm="play"`. Malformed session IDs return 404. No error includes credentials, captured content, storage details, or stack traces.

## Cursor input

The only supported query parameter is `after`. Omit it to start at `0-0`. Reject unknown parameters, duplicate parameters, and empty values with 400. Bound the complete encoded query string to 128 UTF-8 bytes before database access.

A cursor is a Redis stream ID: two canonical unsigned decimal integers separated by a hyphen. Each component fits an unsigned 64-bit integer; no signs, spaces, or leading zeros except the value `0`. Compare components without converting them to JavaScript floating-point numbers. `0-0` is the initial sentinel.

Reads are exclusive: return retained events with IDs greater than `after`, ordered from oldest to newest. A cursor does not grant access and is meaningful only within its session. After authorization, reject a cursor ahead of the latest retained event with 400 `invalid_cursor`. A nonzero cursor on an empty stream is also invalid; reset to `0-0` to resume. Never silently wait behind a future cursor.

## Response and pagination

Successful GET returns HTTP 200, `Content-Type: application/json`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`:

```json
{
  "events": [],
  "nextCursor": "0-0",
  "hasMore": false,
  "cursorBehindRetention": false,
  "expiresAt": "2026-10-09T20:00:00Z"
}
```

Events use the shape in the [capture contract](capture.md), combining the stored JSON payload, Redis timestamp, and stream ID. Keep body data base64; never render or execute captured content. Do not include token digests, raw credentials, or database key names. `expiresAt` is the fixed session deadline in UTC RFC 3339 format.

| Field                   | Meaning                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `events`                | Up to 10 retained events, also bounded by the response byte limit.                   |
| `nextCursor`            | Last returned event ID; unchanged from the input cursor when no events are returned. |
| `hasMore`               | Additional retained events existed after this page at the time of the read.          |
| `cursorBehindRetention` | A nonzero input cursor is earlier than the oldest retained event.                    |
| `expiresAt`             | Fixed deadline; polling does not extend it.                                          |

Set `cursorBehindRetention` only according to the stated comparison. It warns that events may have been lost to trimming; it does not claim an exact loss count. Return the available events rather than conceal a possible gap. An initial `0-0` read starts at the oldest currently retained event and does not promise complete session history.

Use named limits of 10 events and 262,144 bytes (256 KiB) for the complete UTF-8 JSON response, including its envelope. Page at an event boundary rather than truncate a body. An event accepted under the capture limits must fit on its own. If more events exist than fit, set `hasMore` and advance only through returned events. Clients must persist the cursor only after processing the page successfully.

Bound the Redis HTTP reply as well, before buffering it. Select a page within a conservative byte budget inside Redis so large captures cannot cause an unbounded reply. Leave room for JSON encoding and response framing. Give reads a dedicated reply policy; retain the existing 4 KiB bound for creation and capture replies. Corrupt or unexpectedly oversized stored data returns a safe 503, not a partial successful page.

The implementation budgets serialized stream entries to 192 KiB inside Redis and caps the complete HTTP reply at 256 KiB. The budget allows six-byte JSON escapes for HTML-sensitive characters. It retrieves one candidate at a time, up to 11 candidates for 10 returned events, including a look-ahead for `hasMore`. The Worker validates each stored event and checks the final JSON response size. Conservative budgeting can produce a shorter page even when another event might fit in the final response.

All read and error responses disable caching. Do not support ETags, conditional 304 responses, long polling, server-sent events, or WebSockets in this stage. HEAD returns status and safe headers without captured content. No CORS allow headers are added.

## Atomic read and expiry

Authorize from session metadata, then atomically revalidate the session ID, read digest, and fixed deadline against Redis time while selecting events. This second check closes the gap between authorization and data retrieval. A session expiring between those steps returns 404 without captures. Read operations never create keys, refresh expiry, or mutate the event stream.

Selection, retention comparison, and `hasMore` use one consistent Redis script snapshot. Implement exclusive selection with [XRANGE](https://redis.io/docs/latest/commands/xrange/). Avoid downloading all 50 captures to construct a smaller page. Read parsing must validate the stored schema before returning it; storage corruption must fail safely without logging payloads.

## Polling and cost

Clients can fetch the next page immediately while `hasMore` is true, subject to their read allowance. Otherwise begin polling at five-second intervals. After empty pages, back off to 10, 20, and then 30 seconds, with jitter; reset after receiving events. Stop at `expiresAt` or a 404. Retry a 503 with backoff. Honor `Retry-After` on 429 responses, and never automatically create a replacement session.

The successful read path normally uses three Redis HTTP calls: monthly workload reservation, metadata authorization, and atomic page selection. A confirmed month mismatch can add one reservation call. HEAD also reserves workload and needs Redis-time/cursor validation; Redis examines stream boundaries, but no event payloads are transferred to or parsed by the Worker. Empty polling still has a cost: polling every five seconds for one hour would use approximately 2,160 HTTP calls before retries or pagination. Backoff reduces that load. Provider command billing can differ from HTTP call counts; measure both commands and bandwidth before launch.

[Monthly budget](workload-budgets.md) exhaustion returns safe 503 with bounded `Retry-After`, including bodyless HEAD responses. Honor `Retry-After` on these responses as well as 429. Well-formed unknown sessions and wrong credentials spend global budget without consuming an owner's authorized-read allowance.

## Errors and verification

| Status | JSON error code       | Meaning                                                                        |
| ------ | --------------------- | ------------------------------------------------------------------------------ |
| 400    | `invalid_request`     | Invalid query syntax or an unexpected/failed/stalled request body.             |
| 400    | `invalid_cursor`      | An authorized cursor is ahead of retained data, or nonzero on an empty stream. |
| 401    | `unauthorized`        | Missing or malformed bearer credentials.                                       |
| 404    | `not_found`           | Malformed ID, unknown or expired session, or incorrect read capability.        |
| 405    | `method_not_allowed`  | Unsupported method.                                                            |
| 429    | `rate_limited`        | The session's minute or lifetime read allowance is exhausted.                  |
| 503    | `service_unavailable` | Storage, transport, schema validation, or configuration failure.               |

The [per-session limits](session-limits.md) define thresholds, Redis-time windows, fixed counter expiry, and 429 behavior. Authorized HEAD, empty polls, and future-cursor attempts consume read admissions. Incorrect credentials do not consume the owner's allowance.

Tests must cover credential separation and cross-session denial; malformed input before storage access; timing-safe digest validation; empty reads; exclusive cursors; numeric ordering and 64-bit boundaries; count and byte pagination; largest accepted captures; retention warnings; unchanged empty-page cursors; future cursors; safe JSON/cache headers; HEAD/OPTIONS behavior; and backend failures without payload exposure.

Real Redis tests must verify snapshot behavior under concurrent capture, fixed expiry after polling, and expiry between authorization and selection. Hosted smoke tests must verify script compatibility and actual quota/bandwidth use before release.
