import { describe, expect, it } from 'vitest'
import {
  captureBody,
  captureHeaders,
  captureQuery,
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  MAX_QUERY_BYTES,
} from '../src/capture-input'

describe('bounded capture input', () => {
  it('accepts exactly 64 KiB and rejects streamed overflow without trusting Content-Length', async () => {
    const exact = new Response(new Uint8Array(MAX_BODY_BYTES)).body
    expect((await captureBody(exact)).byteLength).toBe(MAX_BODY_BYTES)
    let cancelled = false
    const overflow = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(MAX_BODY_BYTES))
        c.enqueue(new Uint8Array([1]))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(captureBody(overflow)).rejects.toMatchObject({ status: 413 })
    expect(cancelled).toBe(true)
  })

  it('cancels stalled bodies without awaiting stalled cancellation', async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel: () => new Promise(() => {}),
    })
    await expect(captureBody(body, 20)).rejects.toMatchObject({ status: 408 })
  })

  it('maps a failed stream to a safe client error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error('private detail'))
      },
    })
    await expect(captureBody(body)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
  })

  it('counts sensitive headers before redacting them', () => {
    const headers = new Headers({
      Authorization: 'x'.repeat(MAX_HEADER_BYTES - 13),
    })
    expect(captureHeaders(headers)).toEqual([])
    headers.set('authorization', 'x'.repeat(MAX_HEADER_BYTES - 12))
    expect(() => captureHeaders(headers)).toThrow('payload_too_large')
  })

  it('enforces the exact header count boundary', () => {
    const headers = new Headers(
      Array.from({ length: 64 }, (_, i) => [`x-${i}`, 'value']),
    )
    expect(captureHeaders(headers)).toHaveLength(64)
    headers.set('x-extra', 'value')
    expect(() => captureHeaders(headers)).toThrow('payload_too_large')
  })

  it('preserves encoded queries and enforces their exact byte boundary', () => {
    expect(captureQuery('https://play.example/#fragment?ignored')).toBe('')
    expect(captureQuery('https://play.example/capture/token?')).toBe('?')
    expect(captureQuery('https://play.example/capture/token?a=%FF')).toBe(
      '?a=%FF',
    )
    expect(
      captureQuery(`https://play.example/?${'x'.repeat(MAX_QUERY_BYTES - 1)}`),
    ).toHaveLength(MAX_QUERY_BYTES)
    expect(() =>
      captureQuery(`https://play.example/?${'x'.repeat(MAX_QUERY_BYTES)}`),
    ).toThrow('payload_too_large')
  })
})
