import type { Handler } from 'hono'
import type { Bindings } from './config'
import { sessionConfig } from './config'
import { hasRequestBody } from './body'
import { createNewSession } from './session-service'

export const createSession: Handler<{ Bindings: Bindings }> = async (c) => {
  c.header('Cache-Control', 'no-store')

  try {
    if (await hasRequestBody(c.req.raw))
      return c.json({ error: 'invalid_request' }, 400)
  } catch {
    return c.json({ error: 'invalid_request' }, 400)
  }

  try {
    const session = await createNewSession(sessionConfig(c.env))
    return c.json(session, 201)
  } catch {
    // Backend and configuration errors must not expose credentials or payloads.
    return c.json({ error: 'service_unavailable' }, 503)
  }
}
