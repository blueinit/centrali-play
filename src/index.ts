import { Hono } from 'hono'
import type { Bindings } from './config'
import { createSession } from './sessions'
import { captureRequest } from './captures'
import { readEvents } from './event-reads'
import { storageControl } from './storage-controls'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ status: 'ok' })
})

app.post('/sessions', storageControl('creation'), createSession)
app.all('/capture/:captureToken', storageControl('capture'), captureRequest)
app.all('/sessions/:id/events', storageControl('read'), readEvents)

app.notFound((c) => c.json({ error: 'not_found' }, 404))

export default app
