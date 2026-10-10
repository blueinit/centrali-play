import type { Context, Handler } from 'hono'
import type { Bindings } from './config'
import { sessionConfig } from './config'
import { authorizeRead } from './read-auth'
import { readInput, ReadRequestError } from './read-input'
import { readEventPage } from './read-store'
import { sessionLimits, SessionRateLimitError } from './session-limits'

function failure(
  c: Context,
  status: 400 | 401 | 404 | 405 | 429 | 503,
  code: string,
) {
  if (status === 401) c.header('WWW-Authenticate', 'Bearer realm="play"')
  if (c.req.raw.method === 'HEAD') return c.body(null, status)
  return c.json({ error: code }, status)
}

async function authorizedPage(c: Context<{ Bindings: Bindings }>) {
  const input = await readInput(c.req.raw, c.req.param('id'))
  const config = sessionConfig(c.env)
  const limits = sessionLimits(c.env)
  const session = await authorizeRead(config, input.id, input.readToken)
  const page = await readEventPage(
    config,
    session,
    input.after,
    input.head,
    limits,
  )
  return page === null ? c.body(null, 200) : c.json(page)
}

export const readEvents: Handler<{ Bindings: Bindings }> = async (c) => {
  c.header('Cache-Control', 'no-store')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Content-Type', 'application/json')
  if (!['GET', 'HEAD'].includes(c.req.raw.method)) {
    c.header('Allow', 'GET, HEAD')
    return failure(c, 405, 'method_not_allowed')
  }
  try {
    return await authorizedPage(c)
  } catch (error) {
    if (error instanceof SessionRateLimitError) {
      c.header('Retry-After', String(error.retryAfter))
      return failure(c, 429, 'rate_limited')
    }
    if (error instanceof ReadRequestError)
      return failure(c, error.status, error.code)
    return failure(c, 503, 'service_unavailable')
  }
}
