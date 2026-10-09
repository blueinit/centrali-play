import { readLimitedText } from './body'
import type { RedisConfig } from './config'

const REDIS_TIMEOUT_MS = 5_000
const MAX_REDIS_RESPONSE_BYTES = 4_096

async function sendRedisCommand(
  config: RedisConfig,
  command: (string | number)[],
): Promise<Response> {
  // Never automatically replay a write after an uncertain network result.
  const response = await fetch(config.redisOrigin, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    redirect: 'manual',
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
  })

  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error('Redis request failed')
  }

  return response
}

function parseRedisReply(text: string): unknown {
  const data: unknown = JSON.parse(text)
  if (
    !data ||
    typeof data !== 'object' ||
    'error' in data ||
    !('result' in data)
  ) {
    throw new Error('Invalid Redis response')
  }

  return data.result
}

export async function redisCommand(
  config: RedisConfig,
  command: (string | number)[],
): Promise<unknown> {
  const response = await sendRedisCommand(config, command)
  const text = await readLimitedText(response.body, MAX_REDIS_RESPONSE_BYTES)
  return parseRedisReply(text)
}
