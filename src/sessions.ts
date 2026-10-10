import type { Handler } from 'hono'
import type { Bindings } from './config'
import { sessionConfig } from './config'
import { hasRequestBody } from './body'
import { createNewSession } from './session-service'
import { admitWorkload } from './workload-controls'
import { WorkloadBudgetError } from './workload-budget'
import {
  sessionAdmissionConfig,
  SessionAdmissionError,
} from './session-admission'

export const createSession: Handler<{ Bindings: Bindings }> = async (c) => {
  c.header('Cache-Control', 'no-store')

  try {
    if (await hasRequestBody(c.req.raw))
      return c.json({ error: 'invalid_request' }, 400)
  } catch {
    return c.json({ error: 'invalid_request' }, 400)
  }

  try {
    const config = sessionConfig(c.env)
    const admission = sessionAdmissionConfig(c.env)
    await admitWorkload(config, c.env, 'creation')
    const session = await createNewSession(config, admission)
    return c.json(session, 201)
  } catch (error) {
    if (
      error instanceof SessionAdmissionError ||
      error instanceof WorkloadBudgetError
    )
      c.header('Retry-After', String(error.retryAfter))
    // Backend and configuration errors must not expose credentials or payloads.
    return c.json({ error: 'service_unavailable' }, 503)
  }
}
