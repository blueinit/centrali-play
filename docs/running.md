# Running Play

Play has a standalone Node.js server and Docker image. Neither requires a Cloudflare account or Wrangler at runtime. Both use the same session, capture, and read handlers as the local Worker tests.

This is a runtime foundation, not a public-launch release: rate limits and strict workload budgets remain unimplemented. Keep instances private while those protections and hosted compatibility checks are completed.

## Local Node server

Use Node.js 24.2 or newer. Start the dedicated Redis container and development bridge as described in the README, then:

```sh
cp .env.example .env
npm run build:node
npm run start:local
```

The Node server listens on `http://127.0.0.1:3000`. Its API is the same as the README examples; use port 3000 instead of 8787. The local bridge remains development tooling and must not be exposed or used as a production gateway.

## Upstash configuration

The standalone server supports the [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi). Supply these variables through your host's environment or secret manager:

| Variable                   | Meaning                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_BASE_URL`          | The externally reachable origin used in capture URLs, such as `https://play.example`. No path, query, user information, or fragment. |
| `UPSTASH_REDIS_REST_URL`   | The database's HTTPS REST origin.                                                                                                    |
| `UPSTASH_REDIS_REST_TOKEN` | Its write-capable REST credential. Never use a read-only token for the app.                                                          |
| `HOST`                     | Listen address: `127.0.0.1` by default; `0.0.0.0` for a container. IPv6 `::1` and `::` are also accepted.                            |
| `PORT`                     | Listen port, 1–65535; default 3000.                                                                                                  |
| `DISABLE_SESSION_CREATION` | Optional `true`/`false` shutdown switch.                                                                                             |
| `DISABLE_STORAGE_ROUTES`   | Optional `true`/`false` switch for all storage routes.                                                                               |

Configuration is validated before the Node listener opens. Invalid configuration exits with a fixed error message, without printing supplied values. A valid configuration does not prove database reachability: `/health` remains a liveness check, and storage failures return safe 503 responses.

Session/capture/read scripts require Redis scripting and the commands described in their contracts. Upstash [documents Lua support](https://upstash.com/docs/redis/overall/compatibility), but this repository's integration tests run against dedicated local Redis. Verify the complete scripts, exact expiry/trim behavior, response sizes, and provider accounting against a dedicated hosted test database before launch.

Use a separate database for each environment. Check current provider quotas and spending settings before provisioning. This setup does not create resources, choose a paid plan, or provide a dollar spending guarantee. Native Redis TCP support is still planned; the development bridge does not make that a production-supported backend.

## Docker

Build from the repository root:

```sh
docker build -t centrali-play:local .
```

Create an ignored `.env` containing the Upstash settings above and the intended public origin. Remove the local example's `HOST=127.0.0.1` or override it as below. Keep the file private; credentials are runtime configuration and are never copied into the image.

```sh
docker run --rm --name centrali-play \
  --env-file .env \
  -e HOST=0.0.0.0 -e PORT=3000 \
  -p 127.0.0.1:3000:3000 \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  centrali-play:local
```

The image runs as an unprivileged user and installs only runtime dependencies in its final stage. The build context allows only source and package manifests, excluding credentials, Git history, and local state. Node images are pinned by digest; update them through reviewed changes.

The example publishes only a loopback port. A deployment should terminate HTTPS at its ingress and route to the private app listener. Set the public origin explicitly; the app does not infer it from caller forwarding headers. Host/account-specific ingress configuration, secrets, and deployment automation belong to the operator's deployment setup.

No request logging middleware is enabled. Any ingress logs must also avoid capture URL credentials, query strings, authorization headers, and payloads. HTTP headers and request timeouts have server bounds, in addition to application body and response limits.

## Shutdown and recovery

SIGINT or SIGTERM stops accepting new connections and allows current requests up to 10 seconds to complete. After that deadline the process closes active connections and exits unsuccessfully. Clients must treat interrupted writes as uncertain and must not assume a retry is safe.

The [operator shutdown switches](maintaining.md#storage-shutdown-switches) can pause storage routes after restarting with updated configuration. They do not cancel requests already in flight. Session expiry remains fixed across restarts; Redis owns the deadline.

Before public exposure, complete the admission controls, trusted ingress policy, hosted tests, resource measurements, and a reviewed release/rollback procedure. The Docker image alone does not complete those checks.
