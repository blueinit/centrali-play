# Per-session limits

Capture and authorized reads have strict per-session limits in both Node and Worker runtimes. Redis enforces admission in the same script as capture append or read selection, after rechecking credentials and the fixed session deadline. Parallel requests share one allowance.

## Configuration

| Environment variable  | Default | Meaning                                               |
| --------------------- | ------- | ----------------------------------------------------- |
| `CAPTURE_PER_MINUTE`  | 60      | Capture admissions per UTC minute.                    |
| `CAPTURE_PER_SESSION` | 200     | Capture admissions over the session lifetime.         |
| `READ_PER_MINUTE`     | 30      | Authorized read admissions per UTC minute.            |
| `READ_PER_SESSION`    | 1000    | Authorized read admissions over the session lifetime. |

Overrides must be decimal integer strings from 1 to 1,000,000, without spaces, signs, or leading zeroes. Omitted values use defaults. Malformed values fail closed with a safe 503 before Redis; the standalone server also rejects them before opening its listener. Apply the same configuration across instances sharing a database. Raising capacity should follow measured command, transfer, and storage usage.

Redis server time determines fixed UTC minute windows. A minute reset preserves lifetime totals. Fixed windows permit bursts on either side of a boundary; these are not rolling-window limits. Capture and read allowances are independent.

## HTTP behavior

Exhaustion returns 429 with `{"error":"rate_limited"}`, `Cache-Control: no-store`, and integer `Retry-After` seconds. HEAD errors are bodyless. A minute limit points to the next minute or earlier session deadline; a lifetime limit points to the session deadline. Clients should honor the delay and stop at expiry rather than automatically replacing sessions.

GET and HEAD read admissions count, including empty polls and authorized future-cursor attempts. Wrong read credentials do not consume the owner's allowance. Unknown capture capabilities do not create counters. Expired sessions return 404 before checking their allowance.

Capture admission occurs after bounded body validation, immediately before append. A denied capture does not append, trim, or refresh event storage. A denied read does not select or transfer event payloads. Preliminary session lookup/authorization still requires Redis calls; these limits alone do not bound anonymous probes or the cost of repeated denials.

## Counter storage and failures

One `play:limits:<session-id>` JSON record holds both routes' minute window, minute count, and lifetime total. The first admitted operation creates it; no counter keys are created per submitted token or IP. Its expiry is always the original session deadline. Reads update admission counters but do not change stored events or extend retention.

The script reserves an admission with a single `SET ... EXAT` before doing the operation. Value and expiry are attached together. A failed counter write leaves existing state untouched and prevents the operation; malformed state fails safely rather than resetting the allowance. Later storage errors, disconnects, or lost responses keep the reservation. Redis scripts do not roll back earlier commands, so the app never automatically retries or refunds uncertain work.

Integration tests use dedicated real Redis, including concurrent minute/lifetime boundaries, deterministic Redis-clock rollover, fixed expiry, invalid credentials, HEAD/future-cursor accounting, corrupt counters, and injected SET failures. The Node listener also verifies the 429 response. Hosted Upstash compatibility and accounting remain launch checks.

Global session admission and [monthly workload budgets](workload-budgets.md) are implemented separately. Host-specific edge controls remain outstanding. Per-session limits are not a spending cap or public-launch approval.
