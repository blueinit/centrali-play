# Monthly workload budget counter

The Redis reservation primitive is implemented and tested locally. **HTTP routes do not use it yet.** It does not currently limit API traffic or provider spending. Route integration, denial caching, verified operation weights, and hosted checks are required before public deployment.

## Reservation behavior

`workloadBudget(scope)` defines one shared record with defaults of 200,000 work units and 2 GiB of reserved transfer per UTC calendar month. Operators can choose positive integer limits up to one trillion through this internal API. Environment configuration will accompany route integration; there are no new runtime bindings in this stage.

`reserveWorkload(config, budget, { units, bytes })` reserves both allowances atomically. Both weights must be positive integers within the same bound. The caller must reserve before its first session lookup or write and must not proceed after an error. The primitive deliberately provides no refund operation: invalid capabilities, downstream errors, disconnects, and lost responses retain spent reservations.

Each scope uses one `play:budget:<scope>` record containing the month start and two totals. Request identifiers and capabilities never become budget keys. All instances sharing a workload must use the same scope and limits. Use a non-evicting Redis policy; deleting, evicting, or changing the scope resets accounting and is not routine recovery.

The application calculates UTC calendar boundaries, including leap years and December rollover. Redis server time decides whether those boundaries are current. A mismatch returns server time without mutating the counter; the caller may correct the window once. An uncertain network or backend result is never replayed. A second mismatch fails closed.

Within the correct month, the script validates the existing bounded record before checking both caps. Denial changes neither allowance and raises `WorkloadBudgetError` with a retry delay between 1 and 60 seconds. A successful reservation uses one `SET ... EXAT` to write both counters with an expiry 60 seconds after month end. Later-month reservations replace prior totals; a future window or malformed state fails closed. Counter storage failure preserves the prior record and expiry.

## Remaining integration work

Apply reservations to every storage-backed route after cheap input checks, including well-formed requests with unknown or incorrect capabilities. Preserve shutdown checks before body or storage work. Map exhaustion to safe 503 responses with bounded `Retry-After`, including bodyless HEAD responses. Cache denials for at most 60 seconds and never beyond their reset; never cache allowances.

Verify conservative operation weights against the maximum serialized scripts, responses, admission registry, and bounded collision retries before enabling them. In particular, the proposed 64 KiB creation allowance in the [abuse-control contract](abuse-controls.md) needs revision or a tighter registry bound: the registry permits a 128 KiB stored record, and creation can retry confirmed collisions. Counter tests use synthetic weights and do not establish provider transfer accounting.

These allowances measure admitted application work, not exact billed Redis commands or bytes. Denied reservation checks also consume resources. Provider measurements, spending controls, trusted ingress, and deployment safeguards remain separate launch requirements.

## Verification

Real Redis tests cover concurrent exhaustion of each cap, atomic denial, fixed expiry, month and year rollover, leap February, clock correction, corrupt/future state, injected storage failure, and lost responses without replay. Protocol tests reject invalid limits, weights, scopes, and replies. Each test deletes only its own generated key.
