import { describe, expect, inject, it } from 'vitest'

function bridgeRequest(body: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${inject('redisHttpPort')}/`, {
    method: 'POST',
    headers: { Authorization: 'Bearer local-development-only', ...headers },
    body,
  })
}

describe('local Redis bridge', () => {
  it.each(['{', '[]', '[{}]', '[true]'])(
    'rejects invalid command %s as a client error',
    async (body) => {
      const response = await bridgeRequest(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'invalid_request' })
    },
  )

  it('returns a usable 413 response for oversized commands', async () => {
    const response = await bridgeRequest(
      JSON.stringify(['PING', 'x'.repeat(262_144)]),
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'too_large' })
  })

  it('rejects missing credentials', async () => {
    const response = await bridgeRequest('["PING"]', { Authorization: '' })
    expect(response.status).toBe(401)
  })

  it('rejects browser-origin requests even with valid credentials', async () => {
    const response = await bridgeRequest('["PING"]', {
      Origin: 'https://attacker.example',
    })
    expect(response.status).toBe(400)
  })
})
