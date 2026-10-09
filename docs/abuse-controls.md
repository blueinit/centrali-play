# Abuse-control contract

This proposes the next implementation stage. These controls are not implemented yet. Public deployment requires this stage, hosted compatibility tests, quota measurements, and a reviewed release workflow.

## Two layers of admission

Apply cheap shape/method checks and Cloudflare-native limits before contacting Redis. Reject oversized headers/queries and malformed identifiers or credentials without database work. Health checks and unknown routes do not contact Redis.

Use edge limits as an outer guard against repeated requests. Cloudflare documents that its [rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) are local to a location and eventually consistent; they are not an exact global accounting mechanism. Use Redis for strict global workload reservations and authenticated session limits.

Every route that could contact Redis must reserve global workload first, including well-formed requests with unknown or incorrect capabilities. Otherwise credential probes could bypass resource accounting. Denied edge requests perform no Redis work. Global reservation denial performs only the admission check, not session lookup, body buffering, or event retrieval.

Do not add another hosted database, queue, or paid service for these controls. Keep the admission policy, client identity, counter script, and HTTP error handling in focused modules.

## Proposed default limits

These are conservative application defaults, not provider quotas. Keep them in named, validated configuration with an operator path to raise capacity after measuring use.

| Guard                                     | Default                                                       | Enforcement                                |
| ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------ |
| Creation per client                       | 3 per 60 seconds.                                             | Approximate edge guard.                    |
| Capture/read attempts per client          | 120 per 60 seconds across both routes.                        | Approximate edge guard.                    |
| Creation across one edge location         | 30 per 60 seconds.                                            | Approximate guard using a fixed route key. |
| Capture/read across one edge location     | 120 per 60 seconds per route.                                 | Approximate guard using fixed route keys.  |
| New sessions globally                     | 20 per UTC hour and 100 per UTC day.                          | Atomic Redis counters.                     |
| Live or pending sessions globally         | 20.                                                           | Atomic Redis registry.                     |
| Captures per live session                 | 60 per UTC minute and 200 for its lifetime.                   | Atomic check with append.                  |
| Authorized read attempts per live session | 30 per UTC minute and 1,000 for its lifetime, including HEAD. | Atomic check with read selection.          |
| Admitted workload globally                | 200,000 work units per UTC calendar month.                    | Atomic Redis reservation.                  |
| Reserved Redis transfer globally          | 2 GiB per UTC calendar month.                                 | Atomic Redis reservation.                  |

Reserve 64 work units for each operation that could reach storage. Reserve 64 KiB of Redis transfer for creation, and 384 KiB for capture or read/HEAD. These weights deliberately exceed normal use and include admission overhead, bounded collision attempts, metadata checks, script commands, and transport framing. They are application safety allowances, not a claim about exact provider billing. The implementation must verify that each admitted operation stays within its allowance.

Do not refund reservations after invalid capabilities, client disconnects, storage errors, or uncertain results. This avoids overspending through retry or refund races. Cheap rejections that never need storage do not reserve workload. Repeated rejected admission checks still consume provider resources; application limits alone cannot guarantee availability during an attack.

The existing 50-event retention bound and fixed session deadline remain unchanged. With 20 live sessions, payload storage is bounded independently of IP count. Measure actual Redis memory, including stream/counter overhead, before approving the profile for hosting.

## Strict counters and session slots

Use Redis server time for all strict windows and deadlines. Check all applicable global caps and reserve their units/bytes atomically. If any cap is exhausted, deny without partially reserving other allowances. An error or uncertain admission result fails closed; never replay it automatically.

All admitted creation attempts reserve a pending session slot before writing metadata. Promote that slot to the session's fixed deadline in the same creation script that creates metadata and the capture lookup. Confirm the reservation is still present before creating a session. Collisions receive only the existing bounded retries under the same reservation.

Pending slots expire after one hour. A failed or uncertain creation may conservatively hold a slot until that deadline; do not release it merely because an HTTP response was lost. Promotion must prevent a slot from expiring before the session it represents. Live and pending slots share the 20-slot bound. Prune expired slots atomically during admission; no background cleanup job is required.

Session counters are updated only after capability and liveness validation. Incorrect read credentials must not consume another session's authorized-read allowance. Unknown capture credentials must not create session counters. Integrate capture counters with the final append and read counters with the final revalidation/selection, so concurrent edge requests cannot exceed strict limits.

Count authorized read attempts even when a future cursor is rejected; the attempt still used storage. Session expiry takes precedence over its exhausted allowance: after the deadline, return 404. Admission counters may change, but reads do not modify captures or extend retention.

Use fixed-cardinality global/window keys and one counter record per validated session. Give session counters the original session expiry. Expire window records after their window plus a bounded cleanup margin. Keep the registry until its last pending/live deadline. Do not create Redis keys per submitted token, unknown session ID, or raw client IP.

Counter failures must not leave permanent records. Validate before mutation, attach deadlines, and handle partial writes explicitly; Redis scripts do not roll back earlier commands after an error. Tests must verify error cleanup as well as successful atomic increments.

## Client identity and privacy

The hosted profile trusts client-address metadata only at the Cloudflare ingress boundary. Validate the platform-supplied `CF-Connecting-IP` under that deployment model; reject missing or malformed identity with a safe 503 before Redis. Never fall back to `X-Forwarded-For`, `Forwarded`, a query parameter, or a caller-selected identity. Worker-to-Worker or additional proxy paths need a separately verified trust policy before support is advertised.

Canonicalize equivalent IPv4/IPv6 representations before making a key. Group IPv6 addresses by /64 to reduce trivial address rotation. Treat the address as a coarse abuse signal, not a user account: shared NATs and networks can share an allowance.

Derive edge client keys using HMAC-SHA-256 with an operator secret and a UTC-day label. Do not persist or log raw IPs. A plain unsalted address hash is insufficient. Keep session guards keyed by validated session identity or a capability digest, never a raw token. Missing key material fails closed in the hosted profile.

Local development uses explicit loopback configuration and synthetic identity; request headers cannot select a profile or disable controls. The local profile requires a loopback Redis origin and is forbidden in the release workflow. Tests use controlled adapters/identities and dedicated Redis, without real hosted credentials.

Application logs may contain only route categories, status codes, and fixed error codes. Do not log URLs, query strings, bearer headers, capture tokens, IPs, bodies, stored events, or provider errors. Verify platform logs/traces as well before deployment; application redaction does not remove data from platform access logs.

## HTTP behavior and shutdown controls

Per-client and per-session rejection returns 429 with `{"error":"rate_limited"}`, `Cache-Control: no-store`, and an integer `Retry-After` in seconds. Edge rejection can conservatively use 60 seconds; strict limits use Redis's time until the next applicable window or session deadline. HEAD errors remain bodyless.

Global capacity/workload exhaustion returns 503 with `{"error":"service_unavailable"}` and a bounded `Retry-After`, without disclosing which budget was exhausted. Missing controls, malformed configuration, or counter/backend failures also return a safe 503. Do not expose counts, IP keys, or provider diagnostics.

Cache denial decisions briefly in an isolate to avoid repeated Redis checks while a global cap is exhausted. Never cache an allowance: cached permits could violate strict global caps. Denial caching may delay recovery slightly; bound it to at most 60 seconds and never beyond the indicated reset time.

Provide operator switches to disable creation independently, or disable all storage-backed routes. A disabled route returns 503 before any Redis call or body read. Health remains a liveness check. Production must explicitly enable the protected profile; missing bindings/secrets or an unsafe profile must not silently disable guards.

Keep CORS disabled in this stage. Add no wildcard or credentialed allow headers; retain capture OPTIONS as an ordinary capture and read OPTIONS as 405. Origin and Referer are not identity or authorization. CORS is a browser policy, not a substitute for capabilities or resource limits. Browser integrations and a reviewed origin allowlist can follow separately.

## Free-tier operation and scaling

Start with free provider plans and bounded availability. Do not enable automatic upgrades or provision paid services as part of this stage. Application caps reserve workload, not dollars; admission failures, platform traffic, and provider accounting remain separate. Verify the current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Upstash pricing and budget policy](https://upstash.com/pricing/redis) against measured use before launch.

For an explicitly approved paid deployment, configure a provider spending limit wherever supported and verify its scope and exhaustion behavior. Upstash currently documents monthly spending caps for pay-as-you-go databases; those do not cap Workers charges. Recheck this at provisioning rather than treating it as a permanent guarantee.

Raise capacity by reviewing configuration and measurements, without changing the capability model or adding new infrastructure by default. Record command counts including script-internal operations, transfer bytes, peak live storage, denied-admission traffic, and Worker CPU use. Global counters intentionally trade availability for bounded admitted work; the operator should understand that trade-off before raising limits.

## Verification requirements

Tests must cover edge rejection before Redis; malformed/proxy-spoofed identity; IPv4/IPv6 canonicalization and /64 grouping; HMAC keys without raw IP/token disclosure; client and session limits; HEAD accounting; disabled routes; safe 429/503 headers; missing hosted bindings/secrets; CORS behavior; and preserved create/capture/read contracts.

Real Redis tests must verify concurrent admission at every strict boundary; UTC window/month rollover; the 20-slot bound including uncertain creation; atomic slot promotion; collision retries; no counter creation for invalid capabilities; fixed counter expiry; no partial reservations on denial; no automatic replay; and cleanup after injected counter errors. Test distributed requests that pass independent edge guards but share one strict Redis budget.

Hosted launch checks must verify trusted ingress, profile restrictions, binding availability, script compatibility, provider accounting, CPU/memory use, logs, and operator disable/rollback procedures. This proposal alone is not deployment approval.
