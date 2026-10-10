import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_REDIS_COMMAND_BYTES, redisCommand } from '../src/redis'
import {
  workloadBudget,
  workloadReservationCommand,
} from '../src/workload-budget'
import { WORKLOAD_COSTS } from '../src/workload-controls'
import { admittedSessionCommand } from '../src/session-store'
import {
  newSessionAdmission,
  sessionAdmissionConfig,
} from '../src/session-admission'
import { appendCaptureCommand } from '../src/capture-store'
import { readEventsCommand } from '../src/read-store'
import { MAX_READ_REPLY_BYTES } from '../src/read-script'
import {
  MAX_BODY_BYTES,
  MAX_HEADER_BYTES,
  MAX_QUERY_BYTES,
} from '../src/capture-input'
import { sessionConfig } from '../src/config'
import { bindings, config } from './capture-fixture'

afterEach(() => vi.restoreAllMocks())
const id = 'a'.repeat(32)
const hash = 'b'.repeat(64)
const budget = workloadBudget('x'.repeat(64), 1e12, 1e12)
const overheadPerCall = 8192 // Bounded origin/token plus framing allowance.
function commandBytes(command: (string | number)[]) {
  return new TextEncoder().encode(JSON.stringify(command)).byteLength
}
function reservationBytes(operation: keyof typeof WORKLOAD_COSTS) {
  // Include the one permitted clock correction and both bounded replies.
  return (
    2 *
    (commandBytes(
      workloadReservationCommand(budget, WORKLOAD_COSTS[operation]),
    ) +
      4096 +
      overheadPerCall)
  )
}

describe('conservative Redis REST transfer allowances', () => {
  it('covers all three confirmed creation attempts with registry headroom', () => {
    const admission = newSessionAdmission(
      sessionAdmissionConfig({
        SESSION_ADMISSION_SCOPE: 'x'.repeat(64),
        SESSIONS_PER_HOUR: '1000000',
        SESSIONS_PER_DAY: '1000000',
        MAX_ACTIVE_SESSIONS: '1000',
      }),
    )
    const command = admittedSessionCommand(
      { id, captureTokenHash: hash, readTokenHash: hash },
      admission,
    )
    const rest =
      reservationBytes('creation') +
      3 * (commandBytes(command) + 4096 + overheadPerCall)
    // Also leave room for three 128 KiB registry reads and two expanded writes.
    const registry = 3 * 131072 + 2 * (2 * 131072 + 1024)
    expect(rest + registry).toBeLessThan(WORKLOAD_COSTS.creation.bytes)
  })

  it('covers maximum capture input with nested JSON escaping', () => {
    const command = appendCaptureCommand(
      { id, captureHash: hash },
      {
        version: 1,
        method: 'OPTIONS',
        query: '"'.repeat(MAX_QUERY_BYTES),
        headers: [['x', '\u0001'.repeat(MAX_HEADER_BYTES - 1)]],
        body: {
          encoding: 'base64',
          data: 'A'.repeat(4 * Math.ceil(MAX_BODY_BYTES / 3)),
          byteLength: MAX_BODY_BYTES,
        },
      },
    )
    const size = commandBytes(command)
    expect(size).toBeLessThanOrEqual(MAX_REDIS_COMMAND_BYTES)
    // Lookup and liveness-check requests fit in 4 KiB each; three replies are bounded.
    const rest =
      reservationBytes('capture') +
      size +
      2 * 4096 +
      3 * (4096 + overheadPerCall)
    expect(rest).toBeLessThan(WORKLOAD_COSTS.capture.bytes)
  })

  it.each([false, true])(
    'covers a bounded read reply, including HEAD=%s',
    (head) => {
      const command = readEventsCommand(
        { id, readTokenHash: hash },
        '18446744073709551615-18446744073709551615',
        head,
      )
      const rest =
        reservationBytes('read') +
        commandBytes(command) +
        4096 +
        MAX_READ_REPLY_BYTES +
        4096 +
        2 * overheadPerCall
      expect(rest).toBeLessThan(WORKLOAD_COSTS.read.bytes)
    },
  )

  it('rejects oversized serialized commands before sending them', async () => {
    const storage = vi.spyOn(globalThis, 'fetch')
    await expect(
      redisCommand(config, [
        'SET',
        'synthetic',
        'x'.repeat(MAX_REDIS_COMMAND_BYTES),
      ]),
    ).rejects.toThrow('Oversized Redis command')
    expect(storage).not.toHaveBeenCalled()
  })

  it('bounds operator origins and credentials used in transfer estimates', () => {
    expect(() =>
      sessionConfig({
        ...bindings,
        UPSTASH_REDIS_REST_TOKEN: 'x'.repeat(2049),
      }),
    ).toThrow()
    expect(() =>
      sessionConfig({
        ...bindings,
        PUBLIC_BASE_URL: `https://${'x'.repeat(2049)}.example`,
      }),
    ).toThrow()
  })
})
