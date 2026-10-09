# Roadmap

Play is in early development. Documentation, local health checks, and session creation are available. The following milestones include completed foundations and planned capabilities; they are not committed release dates.

| Milestone                        | Deliverable                                                                                     | Verification focus                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1. Foundation                    | Documentation, license, security policy, ownership.                                             | Scope, clarity, license.                           |
| 2. Runnable skeleton (available) | Strict TypeScript, Hono health route, Wrangler, formatting, Worker-runtime tests, CI, lockfile. | Readable structure, reproducible local setup.      |
| 3. Session creation (available)  | API contract, Redis HTTP transport, independent tokens, fixed expiry.                           | Token security, real Redis verification, failures. |
| 4. Capture                       | Raw body handling, header/body limits, bounded storage.                                         | Binary input, concurrency, expiry races.           |
| 5. Reads                         | Authorized cursor reads and bounded responses.                                                  | Trimming, caching, polling cost.                   |
| 6. Abuse controls                | IP/session/read limits, proxy trust, CORS, safe logging/errors.                                 | Bypasses, quota protection, privacy.               |
| 7. Launch                        | End-to-end checks, hosted config, reviewed deployment workflow, runbook.                        | Free-tier use, secret isolation, rollback.         |

The first public release requires all security controls to be verified. Expiry races and concurrent writes need testing against real Redis, not only mocks.

Client integrations and a graphical viewer are outside the current scope.
