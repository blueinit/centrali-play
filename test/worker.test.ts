import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('Worker HTTP contract', () => {
  it('reports liveness as JSON without caching', async () => {
    const response = await exports.default.fetch('https://example.test/health')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ status: 'ok' })
  })

  it.each([
    ['GET', '/unknown'],
    ['POST', '/capture/example'],
    ['GET', '/sessions/example/events'],
    ['POST', '/health'],
  ])('returns JSON 404 for %s %s', async (method, path) => {
    const response = await exports.default.fetch(
      `https://example.test${path}`,
      {
        method,
      },
    )

    expect(response.status).toBe(404)
    expect(response.headers.get('Content-Type')).toBe('application/json')
    expect(await response.json()).toEqual({ error: 'not_found' })
  })
})
