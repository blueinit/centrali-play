import { describe, expect, it } from 'vitest'
import { parseStoredEvent } from '../src/stored-event'
import { emptyCapture } from './capture-fixture'

function entry(payload: unknown = emptyCapture, timestamp = '1700000000000') {
  return [
    '1700000000000-1',
    ['event', JSON.stringify(payload), 'receivedAt', timestamp],
  ]
}

describe('stored-event validation', () => {
  it('preserves empty arrays and returns only the documented event fields', () => {
    expect(parseStoredEvent(entry())).toEqual({
      ...emptyCapture,
      id: '1700000000000-1',
      receivedAt: 1700000000000,
    })
  })

  it.each([
    { ...emptyCapture, readToken: 'secret' },
    { ...emptyCapture, version: 2 },
    { ...emptyCapture, headers: {} },
    { ...emptyCapture, headers: [['authorization', 'secret']] },
    { ...emptyCapture, headers: [['x-test', 'bad\r\nvalue']] },
    {
      ...emptyCapture,
      body: { encoding: 'base64', data: 'AA==', byteLength: 0 },
    },
    {
      ...emptyCapture,
      body: { encoding: 'base64', data: 'AB==', byteLength: 1 },
    },
    { ...emptyCapture, body: { encoding: 'text', data: '', byteLength: 0 } },
  ])('rejects corrupt or credential-bearing stored data', (payload) => {
    expect(() => parseStoredEvent(entry(payload))).toThrow()
  })

  it.each(['-1', 'NaN', '1e3', '1700000000000.5', '9007199254740993'])(
    'rejects invalid timestamp %s',
    (timestamp) => {
      expect(() => parseStoredEvent(entry(emptyCapture, timestamp))).toThrow()
    },
  )
})
