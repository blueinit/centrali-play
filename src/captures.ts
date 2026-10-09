import type { Context, Handler } from 'hono'
import type { Bindings } from './config'
import { sessionConfig } from './config'
import {
  captureInput,
  captureMetadata,
  CaptureInputError,
} from './capture-input'
import { appendCapture, findCaptureSession } from './capture-store'
import { tokenDigest } from './tokens'

const CAPTURE_METHODS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]

function failure(
  c: Context,
  status: 400 | 404 | 405 | 408 | 413 | 503,
  code: string,
) {
  if (c.req.raw.method === 'HEAD') return c.body(null, status)
  return c.json({ error: code }, status)
}

async function persistRequest(
  c: Context<{ Bindings: Bindings }>,
  token: string,
) {
  const metadata = captureMetadata(c.req.raw)
  const config = sessionConfig(c.env)
  const session = await findCaptureSession(config, await tokenDigest(token))
  if (!session) return failure(c, 404, 'not_found')
  const input = await captureInput(c.req.raw, metadata)
  if (!(await appendCapture(config, session, input)))
    return failure(c, 404, 'not_found')
  return c.body(null, 204)
}

export const captureRequest: Handler<{ Bindings: Bindings }> = async (c) => {
  c.header('Cache-Control', 'no-store')
  if (!CAPTURE_METHODS.includes(c.req.raw.method)) {
    c.header('Allow', CAPTURE_METHODS.join(', '))
    return failure(c, 405, 'method_not_allowed')
  }
  const token = c.req.param('captureToken')
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    return failure(c, 404, 'not_found')
  try {
    return await persistRequest(c, token)
  } catch (error) {
    if (error instanceof CaptureInputError)
      return failure(c, error.status, error.code)
    return failure(c, 503, 'service_unavailable')
  }
}
