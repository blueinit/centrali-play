import type { Handler } from 'hono'
import type { Bindings } from './config'
import { sessionConfig } from './config'
import { storeSession } from './session-store'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

function randomToken(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function tokenDigest(token: string): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)),
    ),
  )
}

async function hasBody(request: Request): Promise<boolean> {
  if (!request.body) return false
  const reader = request.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return false
      if (value.byteLength > 0) return true
    }
  } finally {
    // Stop reading on the first byte instead of buffering an arbitrary body.
    void reader.cancel().catch(() => {})
  }
}

export const createSession: Handler<{ Bindings: Bindings }> = async (c) => {
  c.header('Cache-Control', 'no-store')

  try {
    if (await hasBody(c.req.raw))
      return c.json({ error: 'invalid_request' }, 400)
  } catch {
    return c.json({ error: 'invalid_request' }, 400)
  }

  try {
    const config = sessionConfig(c.env)
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = randomToken(16)
      const captureToken = randomToken(32)
      const readToken = randomToken(32)
      const [captureHash, readHash] = await Promise.all([
        tokenDigest(captureToken),
        tokenDigest(readToken),
      ])
      const expiresAt = await storeSession(config, id, captureHash, readHash)
      if (expiresAt === 0) continue

      return c.json(
        {
          id,
          captureUrl: `${config.publicOrigin}/capture/${captureToken}`,
          readToken,
          expiresAt: new Date(expiresAt * 1_000).toISOString(),
        },
        201,
      )
    }
  } catch {
    // Backend and configuration errors must not expose credentials or payloads.
  }

  return c.json({ error: 'service_unavailable' }, 503)
}
