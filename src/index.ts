import { Hono } from 'hono'

const app = new Hono()

app.get('/health', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ status: 'ok' })
})

app.notFound((c) => c.json({ error: 'not_found' }, 404))

export default app
