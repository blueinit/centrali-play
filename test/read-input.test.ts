import { describe, expect, it } from 'vitest'
import { compareCursors, isCursor, readInput } from '../src/read-input'

const id = 'a'.repeat(32)
const token = 'b'.repeat(64)
function request(query = '', authorization = `Bearer ${token}`) {
  return new Request(`https://play.example/sessions/${id}/events${query}`, {
    headers: { Authorization: authorization },
  })
}

describe('read input', () => {
  it.each([
    '0-0',
    '0-1',
    '9007199254740993-1',
    '18446744073709551615-18446744073709551615',
  ])('accepts canonical unsigned cursor %s', (cursor) => {
    expect(isCursor(cursor)).toBe(true)
  })

  it.each([
    '',
    '01-0',
    '0-01',
    '-1-0',
    '1',
    '1-0 ',
    '+1-0',
    '18446744073709551616-0',
    '0-18446744073709551616',
  ])('rejects invalid cursor %s', (cursor) => {
    expect(isCursor(cursor)).toBe(false)
  })

  it('orders components numerically without floating-point rounding', () => {
    expect(compareCursors('9-100', '10-0')).toBe(-1)
    expect(compareCursors('10-9', '10-10')).toBe(-1)
    expect(compareCursors('9007199254740993-0', '9007199254740992-0')).toBe(1)
    expect(compareCursors('1-1', '1-1')).toBe(0)
  })

  it('accepts a case-insensitive scheme and defaults to the initial cursor', async () => {
    expect(await readInput(request('', `bEaReR ${token}`), id)).toEqual({
      id,
      readToken: token,
      after: '0-0',
      head: false,
    })
  })

  it.each([
    '?after=',
    '?after=0-0&after=1-0',
    '?token=secret',
    '?limit=50',
    '?after=1-0&other=x',
    `?${'x'.repeat(128)}`,
  ])('rejects invalid query %s', async (query) => {
    await expect(readInput(request(query), id)).rejects.toMatchObject({
      status: 400,
    })
  })

  it.each([
    '',
    'Basic secret',
    `Bearer ${token}, Bearer ${token}`,
    `Bearer ${token} extra`,
    `Bearer ${token.toUpperCase()}`,
  ])('rejects malformed bearer credentials', async (authorization) => {
    await expect(
      readInput(request('', authorization), id),
    ).rejects.toMatchObject({ status: 401 })
  })

  it('rejects unexpected streams without waiting for their complete body', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]))
      },
    })
    // Fetch rejects GET bodies at construction; exercise the shared guard directly.
    const incoming = new Request(request(), { method: 'POST', body })
    await expect(readInput(incoming, id)).rejects.toMatchObject({ status: 400 })
  })
})
