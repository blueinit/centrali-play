import type { CaptureInput } from './capture-input'
import {
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  MAX_HEADERS,
  MAX_QUERY_BYTES,
  CAPTURE_METHODS,
  isSensitiveHeader,
} from './capture-input'
import { isCursor } from './read-input'

export type StoredEvent = CaptureInput & { id: string; receivedAt: number }

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid stored object')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    throw new Error('Invalid stored fields')
  }
  return record
}

function headerPair(pair: unknown): [string, string] {
  if (
    !Array.isArray(pair) ||
    pair.length !== 2 ||
    typeof pair[0] !== 'string' ||
    typeof pair[1] !== 'string'
  ) {
    throw new Error('Invalid stored header')
  }
  const [name, content] = pair as [string, string]
  if (
    !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name) ||
    isSensitiveHeader(name) ||
    /[\r\n]/.test(content)
  ) {
    throw new Error('Invalid stored header')
  }
  return [name, content]
}

function headers(value: unknown): [string, string][] {
  if (!Array.isArray(value) || value.length > MAX_HEADERS)
    throw new Error('Invalid stored headers')
  const result = value.map(headerPair)
  const bytes = result.reduce(
    (sum, pair) => sum + new TextEncoder().encode(pair.join('')).byteLength,
    0,
  )
  if (bytes > MAX_HEADER_BYTES) throw new Error('Oversized stored headers')
  return result
}

function body(value: unknown): CaptureInput['body'] {
  const record = object(value, ['encoding', 'data', 'byteLength'])
  if (
    record.encoding !== 'base64' ||
    typeof record.data !== 'string' ||
    typeof record.byteLength !== 'number' ||
    !Number.isSafeInteger(record.byteLength) ||
    record.byteLength < 0 ||
    record.byteLength > MAX_BODY_BYTES ||
    record.data.length > Math.ceil(MAX_BODY_BYTES / 3) * 4
  )
    throw new Error('Invalid stored body')
  const decoded = atob(record.data)
  if (decoded.length !== record.byteLength || btoa(decoded) !== record.data)
    throw new Error('Invalid stored encoding')
  return {
    encoding: 'base64',
    data: record.data,
    byteLength: record.byteLength,
  }
}

function payload(raw: string): CaptureInput {
  const record = object(JSON.parse(raw), [
    'version',
    'method',
    'query',
    'headers',
    'body',
  ])
  if (
    record.version !== 1 ||
    typeof record.method !== 'string' ||
    !CAPTURE_METHODS.includes(record.method) ||
    typeof record.query !== 'string' ||
    (record.query !== '' && !record.query.startsWith('?')) ||
    new TextEncoder().encode(record.query).byteLength > MAX_QUERY_BYTES
  )
    throw new Error('Invalid stored capture')
  return {
    version: 1,
    method: record.method,
    query: record.query,
    headers: headers(record.headers),
    body: body(record.body),
  }
}

function eventFields(fields: unknown): { raw: string; receivedAt: number } {
  if (
    !Array.isArray(fields) ||
    fields.length !== 4 ||
    fields[0] !== 'event' ||
    typeof fields[1] !== 'string' ||
    fields[2] !== 'receivedAt' ||
    typeof fields[3] !== 'string'
  ) {
    throw new Error('Invalid stored event fields')
  }
  const receivedAt = Number(fields[3])
  if (
    !Number.isSafeInteger(receivedAt) ||
    receivedAt < 0 ||
    String(receivedAt) !== fields[3]
  )
    throw new Error('Invalid stored timestamp')
  return { raw: fields[1], receivedAt }
}

export function parseStoredEvent(value: unknown): StoredEvent {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    !isCursor(value[0]) ||
    value[0] === '0-0'
  )
    throw new Error('Invalid stored event ID')
  const { raw, receivedAt } = eventFields(value[1])
  return { ...payload(raw), id: value[0], receivedAt }
}
