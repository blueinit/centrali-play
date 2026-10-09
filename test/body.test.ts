import { describe, expect, it } from 'vitest'
import { hasRequestBody, readLimitedText } from '../src/body'

describe('bounded body handling', () => {
  it('times out and cancels a stalled request stream', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const request = new Request('https://play.example', {
      method: 'POST',
      body,
    })
    await expect(hasRequestBody(request, 20)).rejects.toThrow('timed out')
    expect(cancelled).toBe(true)
  })

  it('decodes UTF-8 split across chunks within the byte limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xe2]))
        controller.enqueue(new Uint8Array([0x82, 0xac]))
        controller.close()
      },
    })
    expect(await readLimitedText(body, 3)).toBe('€')
  })

  it('counts bytes rather than characters and cancels oversized replies', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('€'))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(readLimitedText(body, 2)).rejects.toThrow('too large')
    expect(cancelled).toBe(true)
  })
})
