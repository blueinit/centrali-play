import { env } from 'cloudflare:workers'
import type { Bindings } from '../src/config'
import { sessionConfig } from '../src/config'
import type { CaptureInput } from '../src/capture-input'
import { eventKey } from '../src/capture-store'
import { sessionLimitKey } from '../src/session-limits'
import { redisCommand } from '../src/redis'
import { createSessionCommand, sessionKeys } from '../src/session-store'
import { generateSessionTokens, tokenDigest } from '../src/tokens'

export const bindings = env as Bindings
export const config = sessionConfig(bindings)
export const emptyCapture: CaptureInput = {
  version: 1,
  method: 'POST',
  query: '',
  headers: [],
  body: { encoding: 'base64', data: '', byteLength: 0 },
}

export async function captureFixture(keys: string[], lifetime = 3_600) {
  const tokens = generateSessionTokens()
  const captureHash = await tokenDigest(tokens.captureToken)
  const record = {
    id: tokens.id,
    captureTokenHash: captureHash,
    readTokenHash: await tokenDigest(tokens.readToken),
  }
  const [metadataKey, lookupKey] = sessionKeys(tokens.id, captureHash)
  const eventsKey = eventKey(tokens.id)
  keys.push(metadataKey, lookupKey, eventsKey, sessionLimitKey(tokens.id))
  const expiresAt = await redisCommand(
    config,
    createSessionCommand(record, lifetime),
  )
  return {
    ...tokens,
    captureHash,
    metadataKey,
    lookupKey,
    eventsKey,
    expiresAt,
  }
}

export async function storedCaptures(key: string) {
  // Test-only transport: large bodies exceed the application's 4 KiB reply bound.
  const response = await fetch(config.redisOrigin, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.redisToken}` },
    body: JSON.stringify(['XRANGE', key, '-', '+']),
  })
  const data = await response.json<{ result: [string, string[]][] }>()
  return data.result.map(([id, fields]) => ({
    id,
    ...JSON.parse(fields[1]!),
    receivedAt: Number(fields[3]),
  }))
}
