import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { startApp, type App } from './app.ts'

export interface ServeOptions {
  host: string
  port: number
  reload: boolean
  timeoutGracefulShutdownMs: number
}

export interface Listening {
  app: App
  server: Server
  url: string
  close(timeoutGracefulShutdownMs: number): Promise<void>
}

export const STARTUP_FAILED = 3

export async function listen(app: App, host: string, port: number): Promise<Listening> {
  const listener = getRequestListener(app.hono.fetch)
  const server = createServer((incoming, outgoing) => {
    void listener(incoming, outgoing)
  })
  try {
    server.listen(port, host)
    await once(server, 'listening')
  } catch (error) {
    await app.close()
    throw error
  }
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? address.port : port
  return {
    app,
    server,
    url: `http://${host}:${bound}`,
    async close(timeoutGracefulShutdownMs) {
      const closed = once(server, 'close')
      server.close()
      server.closeIdleConnections()
      const force = setTimeout(() => server.closeAllConnections(), timeoutGracefulShutdownMs)
      await closed
      clearTimeout(force)
      await app.close()
    },
  }
}

const ignore = (): void => {}

function untilSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const stop = (signal: NodeJS.Signals): void => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve(signal)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

async function reloading(script: string, options: ServeOptions): Promise<number> {
  const args = ['--watch', script, 'serve', '--host', options.host, '--port', String(options.port)]
  const child = spawn(process.execPath, args, { stdio: 'inherit' })
  // Ctrl+C reaches the watcher and the server from the terminal; a SIGTERM sent to the
  // supervisor alone is passed on.
  const forward = (): void => {
    child.kill('SIGTERM')
  }
  process.on('SIGINT', ignore)
  process.on('SIGTERM', forward)
  const [code]: unknown[] = await once(child, 'exit')
  process.off('SIGINT', ignore)
  process.off('SIGTERM', forward)
  return typeof code === 'number' ? code : 1
}

/** Serves until SIGINT or SIGTERM and returns the exit code. */
export async function runServer(script: string, options: ServeOptions): Promise<number> {
  if (options.reload) return await reloading(script, options)
  let app: App
  try {
    app = await startApp({ host: options.host })
  } catch (error) {
    console.error(error)
    console.error('Startup failed.')
    return STARTUP_FAILED
  }
  let listening: Listening
  try {
    listening = await listen(app, options.host, options.port)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
  console.log(`Mokosz API on ${listening.url}`)
  await untilSignal()
  await listening.close(options.timeoutGracefulShutdownMs)
  return 0
}
