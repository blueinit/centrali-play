import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { nodeConfig } from '../src/node-config'
import { startNodeServer } from '../src/node-server'
import { startRedisHttp } from '../scripts/redis-http'
import { redisCommand } from '../src/redis'
import { sessionConfig } from '../src/config'
import { sessionKeys } from '../src/session-store'
import { tokenDigest } from '../src/tokens'
import { eventKey } from '../src/capture-store'
import { sessionLimitKey } from '../src/session-limits'
import type { CreatedSession } from '../src/session-service'
import type { EventPage } from '../src/read-store'

const localEnv = {
  PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
  UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079',
  UPSTASH_REDIS_REST_TOKEN: 'local-development-only',
}

test('Node startup validates configuration and defaults to loopback', () => {
  assert.equal(nodeConfig(localEnv).hostname, '127.0.0.1')
  assert.equal(nodeConfig(localEnv).port, 3000)
  for (const PORT of ['0', '65536', '-1', ' 3000', '3e3'])
    assert.throws(() => nodeConfig({ ...localEnv, PORT }))
  assert.throws(() => nodeConfig({ ...localEnv, HOST: 'example.test' }))
  assert.throws(() =>
    nodeConfig({ ...localEnv, DISABLE_STORAGE_ROUTES: 'yes' }),
  )
  assert.throws(() => nodeConfig({ ...localEnv, UPSTASH_REDIS_REST_TOKEN: '' }))
  assert.throws(() => nodeConfig({ ...localEnv, READ_PER_MINUTE: '0' }))
  assert.throws(() => nodeConfig({ ...localEnv, MAX_ACTIVE_SESSIONS: '0' }))
  assert.throws(() => nodeConfig({ ...localEnv, MONTHLY_WORK_UNITS: '0' }))
  assert.throws(() =>
    nodeConfig({ ...localEnv, MONTHLY_REDIS_BYTES: '1000000000001' }),
  )
  assert.equal(
    nodeConfig({ ...localEnv, READ_PER_SESSION: '3' }).bindings
      .READ_PER_SESSION,
    '3',
  )
})

test('built executable rejects invalid config without leaking values', () => {
  const result = spawnSync(process.execPath, ['dist/server.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, PUBLIC_BASE_URL: 'private-invalid-value' },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.trim(), 'Invalid server configuration')
})

test('Node HTTP server captures and reads through real Redis', async () => {
  const bridge = await startRedisHttp(process.env.REDIS_TEST_URL)
  const bindings = {
    ...localEnv,
    READ_PER_SESSION: '3',
    SESSION_ADMISSION_SCOPE: `test-${crypto.randomUUID()}`,
    MAX_ACTIVE_SESSIONS: '1',
    MONTHLY_WORK_UNITS: '512',
    UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${bridge.port}`,
  }
  const config = sessionConfig(bindings)
  const server = startNodeServer({ bindings, port: 0, hostname: '127.0.0.1' })
  const keys: string[] = [
    `play:admission:${bindings.SESSION_ADMISSION_SCOPE}`,
    `play:budget:${bindings.SESSION_ADMISSION_SCOPE}`,
  ]
  try {
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    bindings.PUBLIC_BASE_URL = origin
    const health = await fetch(`${origin}/health`)
    assert.deepEqual(await health.json(), { status: 'ok' })
    const creation = await fetch(`${origin}/sessions`, { method: 'POST' })
    assert.equal(creation.status, 201)
    const session = (await creation.json()) as CreatedSession
    const hash = await tokenDigest(session.captureUrl.split('/').at(-1)!)
    keys.push(
      ...sessionKeys(session.id, hash),
      eventKey(session.id),
      sessionLimitKey(session.id),
    )
    const payload = new Uint8Array([0, 255, 10, 128])
    const capture = await fetch(session.captureUrl, {
      method: 'POST',
      body: payload,
      headers: { Authorization: 'synthetic-secret' },
    })
    assert.equal(capture.status, 204)
    const url = `${origin}/sessions/${session.id}/events`
    assert.equal((await fetch(url)).status, 401)
    assert.equal(
      (
        await fetch(url, {
          headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
        })
      ).status,
      404,
    )
    const headers = { Authorization: `Bearer ${session.readToken}` }
    const read = await fetch(url, { headers })
    assert.equal(read.status, 200)
    assert.equal(read.headers.get('Cache-Control'), 'no-store')
    const page = (await read.json()) as EventPage
    assert.equal(page.events.length, 1)
    assert.deepEqual(
      Buffer.from(page.events[0]!.body.data, 'base64'),
      Buffer.from(payload),
    )
    assert.equal(JSON.stringify(page).includes('synthetic-secret'), false)
    assert.equal(page.expiresAt, session.expiresAt)
    const poll = await fetch(`${url}?after=${page.nextCursor}`, { headers })
    assert.equal(((await poll.json()) as EventPage).events.length, 0)
    const head = await fetch(url, { method: 'HEAD', headers })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    const limited = await fetch(url, { headers })
    assert.equal(limited.status, 429)
    assert.deepEqual(await limited.json(), { error: 'rate_limited' })
    assert.ok(Number(limited.headers.get('Retry-After')) > 0)
    const capacity = await fetch(`${origin}/sessions`, { method: 'POST' })
    assert.equal(capacity.status, 503)
    assert.deepEqual(await capacity.json(), { error: 'service_unavailable' })
    assert.equal(capacity.headers.get('Retry-After'), '60')
    const exhausted = await fetch(url, { headers })
    assert.equal(exhausted.status, 503)
    assert.deepEqual(await exhausted.json(), { error: 'service_unavailable' })
    assert.equal(exhausted.headers.get('Retry-After'), '60')
    const exhaustedHead = await fetch(url, { method: 'HEAD', headers })
    assert.equal(exhaustedHead.status, 503)
    assert.equal(await exhaustedHead.text(), '')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (keys.length) await redisCommand(config, ['DEL', ...keys])
    await bridge.close()
  }
})
