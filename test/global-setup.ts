import type { TestProject } from 'vitest/node'
import { startRedisHttp } from '../scripts/redis-http'

export default async function setup(project: TestProject) {
  const bridge = await startRedisHttp(process.env.REDIS_TEST_URL)
  project.provide('redisHttpPort', bridge.port)
  return () => bridge.close()
}
