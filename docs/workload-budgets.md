# Monthly workload budgets

Session creation, capture, and event reads reserve shared monthly workload before their first session lookup or write. Well-formed unknown capabilities and wrong read credentials also reserve workload. Cheap input rejections, health checks, unknown routes, and disabled storage routes do not contact Redis. Capture bodies are read only after admission and a live-session check.

## Configuration

| Variable                  | Default      | Meaning                                                                |
| ------------------------- | ------------ | ---------------------------------------------------------------------- |
| `MONTHLY_WORK_UNITS`      | `200000`     | Reserved work units per UTC calendar month.                            |
| `MONTHLY_REDIS_BYTES`     | `2147483648` | Reserved Redis transfer bytes per UTC calendar month (2 GiB).          |
| `SESSION_ADMISSION_SCOPE` | `default`    | Shared operator scope for both creation capacity and workload budgets. |

Limits must be decimal integer strings from 1 to 1,000,000,000,000, without signs, whitespace, or leading zeroes. Invalid configuration fails closed before Redis; Node validates it before opening its listener. Scope syntax is described in [session admission](session-admission.md). These settings are available in both runtimes and are never selected by request headers or queries.

All instances sharing a workload must use the same scope and limits. Use a non-evicting Redis policy; deleting, evicting, or changing the scope resets accounting and is not routine recovery. Raising or lowering limits preserves the month's spent totals. Configuration updates require restarting the Node process or updating Worker bindings.

## Reservations and exhaustion

| Operation                                           | Work units | Reserved transfer |
| --------------------------------------------------- | ---------- | ----------------- |
| Creation, including all confirmed collision retries | 64         | 1 MiB             |
| Capture, including HEAD and OPTIONS                 | 64         | 384 KiB           |
| Event read, including HEAD and empty pages          | 64         | 384 KiB           |

Each request reserves once. The Redis script checks both caps before one expiring write, so denials cannot partially spend either allowance. Invalid capabilities, downstream errors, client disconnects, and lost responses retain spent reservations. There is no refund or automatic replay after an uncertain result. Session quotas are separate: wrong credentials spend global budget without changing a session's authorized-read counter.

Exhaustion returns 503 with `{"error":"service_unavailable"}`, `Cache-Control: no-store`, and an integer `Retry-After` from 1 to 60 seconds. HEAD responses remain bodyless. No response discloses counts or which budget was exhausted. Backend or configuration failures return safe 503 responses without treating them as confirmed exhaustion. Existing sessions can become temporarily unavailable when a global budget is exhausted; expiry continues normally.

The isolate caches only confirmed denials, never permits. Cache entries distinguish Redis backend and credential, scope, limits, and operation weights. The cache contains at most 64 entries. Deadlines use a monotonic clock and subtract transport delay and Redis's fractional second, so they last at most 59 seconds and cannot outlive the indicated reset. One-second denials are not cached. Cache entries contain only operator configuration, not request credentials, addresses, or payloads. Cached denials can briefly delay recovery after a database reset; configuration or credential changes select a fresh cache entry.

## Windows and storage

Each scope uses one `play:budget:<scope>` record containing the month start and two totals. Request identifiers and capabilities never become budget keys. The application proposes UTC calendar boundaries, including leap years and December rollover; Redis time decides whether they are current. A mismatch returns server time without mutation and permits one clock correction. A second mismatch fails closed.

The script validates the bounded record before mutation. Successful reservations use `SET ... EXAT` with an expiry 60 seconds after month end. Later-month reservations replace prior totals. A future window or malformed state fails closed; atomic storage failure preserves the prior record and expiry.

## Allowance verification and limits

Tests instrument real Redis scripts to count every `redis.call` and `redis.pcall`, along with the outer REST commands. The 64-unit allowance covers three creation attempts, pending/live promotion, maximum read look-ahead, and a confirmed clock correction. Script error paths stop early; cleanup commands fit within the same allowance.

Serialized-size tests cover script bodies, bounded replies, maximum body/header/query sizes, nested JSON escaping, and both reservation attempts. Redis commands are limited to 256 KiB before sending; ordinary replies remain bounded to 4 KiB and read replies to 256 KiB. Origins and the REST token are bounded to 2 KiB, with 8 KiB per REST call allowed for request metadata and framing. Creation also leaves conservative headroom for the 128 KiB admission registry and its bounded retries. Recheck these tests when changing scripts, input bounds, or transport policy.

These allowances measure admitted application work, not exact provider billing. Arbitrary provider response headers, rejected checks, transport overhead, and provider accounting still require hosted measurement. Denied reservation checks consume resources despite not reserving workload; caching reduces repeated checks only within an isolate. Provider spending settings, trusted ingress guards, hosted compatibility tests, and deployment safeguards remain public-launch requirements.

## Verification

Tests cover concurrent HTTP and Redis exhaustion, atomic denial, fixed expiry, UTC month/year rollover and leap February, clock correction, corrupt/future state, injected storage failure, and lost responses without replay. Integration tests verify every route, incorrect credentials, no body read on capture denial, cheap rejection, shutdown precedence, safe HEAD/503 behavior, configuration validation, cache isolation/expiry/cardinality, and standalone Node enforcement. Each test deletes only its own generated keys.
