import type { TestProject } from 'vitest/node'
import { startRedisHttp } from '../scripts/redis-http'
import { redisCommand } from '../src/redis'

export default async function setup(project: TestProject) {
  const bridge = await startRedisHttp(process.env.REDIS_TEST_URL)
  project.provide('redisHttpPort', bridge.port)
  const scope = `test-${crypto.randomUUID()}`
  project.provide('admissionScope', scope)
  return async () => {
    try {
      await redisCommand(
        {
          redisOrigin: `http://127.0.0.1:${bridge.port}`,
          redisToken: 'local-development-only',
        },
        ['DEL', `play:admission:${scope}`, `play:budget:${scope}`],
      )
    } finally {
      await bridge.close()
    }
  }
}
