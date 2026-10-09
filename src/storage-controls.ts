import type { MiddlewareHandler } from 'hono'
import type { Bindings } from './config'

type StorageRoute = 'creation' | 'capture' | 'read'
const SHUTDOWN_RETRY_SECONDS = 60

function disabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false
  if (value === 'true') return true
  throw new Error('Invalid shutdown configuration')
}

function storageDisabled(env: Bindings, route: StorageRoute): boolean {
  // Validate both switches on every storage route; a typo must fail closed.
  const all = disabled(env.DISABLE_STORAGE_ROUTES)
  const creation = disabled(env.DISABLE_SESSION_CREATION)
  return all || (route === 'creation' && creation)
}

export function storageControl(
  route: StorageRoute,
): MiddlewareHandler<{ Bindings: Bindings }> {
  return async (c, next) => {
    let stop = true
    try {
      stop = storageDisabled(c.env, route)
    } catch {
      // Do not expose configuration values or proceed with an unsafe switch.
    }
    if (!stop) return next()

    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'application/json')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Retry-After', String(SHUTDOWN_RETRY_SECONDS))
    if (c.req.raw.method === 'HEAD') return c.body(null, 503)
    return c.json({ error: 'service_unavailable' }, 503)
  }
}
