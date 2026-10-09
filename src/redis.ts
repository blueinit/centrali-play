import type { SessionConfig } from './config'

export async function redisCommand(
  config: SessionConfig,
  command: (string | number)[],
): Promise<unknown> {
  const response = await fetch(config.redisOrigin, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
    redirect: 'manual',
    signal: AbortSignal.timeout(5_000),
  })

  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error('Redis request failed')
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty Redis response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4_096) throw new Error('Oversized Redis response')
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const data: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (
    !data ||
    typeof data !== 'object' ||
    'error' in data ||
    !('result' in data)
  ) {
    throw new Error('Invalid Redis response')
  }

  // Never automatically replay a write after an uncertain network result.
  return data.result
}
