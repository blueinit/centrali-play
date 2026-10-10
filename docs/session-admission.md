# Global session admission

Creation shares a Redis admission ledger across Node and Worker instances. It limits new creation admissions per UTC hour/day and the number of live or pending sessions. These limits protect session capacity; global command/transfer budgets remain a separate, unfinished stage.

## Configuration

| Variable                  | Default   | Meaning                                        |
| ------------------------- | --------- | ---------------------------------------------- |
| `SESSIONS_PER_HOUR`       | 20        | Creation admissions per UTC hour.              |
| `SESSIONS_PER_DAY`        | 100       | Creation admissions per UTC day.               |
| `MAX_ACTIVE_SESSIONS`     | 20        | Live and pending sessions combined.            |
| `SESSION_ADMISSION_SCOPE` | `default` | Operator-selected scope for the shared ledger. |

Count overrides must be decimal integer strings, without spaces, signs, or leading zeroes. Hour/day values allow 1–1,000,000; active capacity allows 1–1,000. The capacity bound keeps registry processing bounded. Invalid settings fail closed before Redis; Node also validates them before opening its listener.

A scope is 1–64 lowercase letters, digits, underscores, or hyphens, starting with a letter or digit. All instances serving one deployment must use the same scope, limits, and database. Request headers/query parameters cannot select it. Separate databases remain recommended for separate environments. Changing scope or deleting/evicting the ledger resets accounting and can bypass capacity protection; treat those as deliberate operator migrations, never normal recovery.

## Atomic creation

The creation script uses Redis server time to reset hour/day windows and prune expired slots. It checks all three caps before reserving anything. Denial leaves counters and session keys unchanged.

On admission, the script saves a pending slot and increments hour/day totals using one expiring `SET`. Only then may it write session metadata and the capture lookup. Successful creation marks that slot live in the same script. Slot promotion failure removes created session keys and leaves the pending reservation in place. Existing metadata/capture collisions are never overwritten.

Only confirmed collisions receive the existing maximum of three credential attempts, all under the same reservation. Collision retries do not consume additional slots or creation admissions. A live reservation cannot be reused to create another session. Backend errors and uncertain responses are not automatically retried or refunded.

Pending slots expire one hour after admission. The created session's deadline cannot exceed its pending deadline: a delayed collision retry may receive a slightly shorter lifetime. Metadata, capture lookup, event storage, and per-session counters keep that fixed deadline. Lost responses and failed creation can conservatively hold capacity for up to an hour.

## Ledger and errors

One `play:admission:<scope>` JSON record holds the current hour/day counts and at most the configured number of pending/live slots. Slot IDs are random opaque reservation IDs, not raw capture/read credentials. Expiry covers the later of the current UTC day plus 60 seconds or the last slot deadline. Expired slots are pruned during the next admission, without a scheduled cleanup job.

Malformed ledger state fails safely rather than resetting it. Use a non-evicting database policy and verify hosted behavior: protection depends on retaining the ledger until its expiry. The bounded JSON registry is intended for modest session capacity; measure memory, scripting work, and command/transfer use before raising defaults.

Capacity exhaustion returns 503 with `{"error":"service_unavailable"}`, `Cache-Control: no-store`, and integer `Retry-After` between 1 and 60 seconds. It does not identify the exhausted cap or disclose usage. Existing capture/read routes remain available subject to their own session limits. Per-client creation 429 behavior belongs to host-specific edge controls.

Denied creation still performs a Redis admission check. These limits do not guarantee a dollar bill or bound credential probes, captures, reads, or denial traffic. Keep instances private until global workload protection, ingress controls, hosted Upstash compatibility, and launch procedures are verified.

## Verification

Real Redis tests cover concurrent boundaries for all three caps, hour/day rollover, slot expiry/reclamation, collision reuse, uncertain creation responses, invalid/corrupt state, and failures during reservation, metadata, lookup, and promotion writes. HTTP tests verify safe exhaustion responses, request scope override rejection, and configuration failure. Node verifies the capacity response through its standalone listener.

Each test run uses a generated scope and deletes only its own ledger/session keys. No test flushes Redis or resets a shared deployment's admission state.
