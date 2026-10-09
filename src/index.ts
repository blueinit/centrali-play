import { Hono } from 'hono'
import type { Bindings } from './config'
import { createSession } from './sessions'
import { captureRequest } from './captures'
import { readEvents } from './event-reads'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ status: 'ok' })
})

app.post('/sessions', createSession)
app.all('/capture/:captureToken', captureRequest)
app.all('/sessions/:id/events', readEvents)

app.notFound((c) => c.json({ error: 'not_found' }, 404))

export default app
