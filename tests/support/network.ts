import net from 'node:net'
import { clearSettingsCache } from '../../src/settings.ts'

export interface Peer {
  host?: string
  port?: number
  path?: string
}

export class SocketPeers {
  readonly connected: Peer[] = []
  readonly listened = new Set<number>()

  /** Ports connected to, minus listeners opened during the test. */
  ports(): Set<number> {
    const ports = new Set<number>()
    for (const peer of this.connected) {
      if (peer.port !== undefined && !this.listened.has(peer.port)) ports.add(peer.port)
    }
    return ports
  }
}

function peerOf(args: unknown[]): Peer {
  const [first, second] = args
  // net.connect() passes its normalized arguments as one array.
  if (Array.isArray(first)) return peerOf(first)
  if (typeof first === 'object' && first !== null) {
    const host: unknown = Reflect.get(first, 'host')
    const port: unknown = Reflect.get(first, 'port')
    const path: unknown = Reflect.get(first, 'path')
    if (typeof path === 'string') return { path }
    return {
      host: typeof host === 'string' ? host : undefined,
      port: port === undefined ? undefined : Number(port),
    }
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { path: first }
  return { host: typeof second === 'string' ? second : undefined, port: Number(first) }
}

export function spyOnSockets(): { peers: SocketPeers; restore(): void } {
  const peers = new SocketPeers()
  // The originals are put back by restore() and always called with their own receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const { connect } = net.Socket.prototype
  // oxlint-disable-next-line typescript/unbound-method
  const { listen } = net.Server.prototype
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    peers.connected.push(peerOf(args))
    const socket: net.Socket = Reflect.apply(connect, this, args)
    return socket
  }
  net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]): net.Server {
    this.once('listening', () => {
      const address = this.address()
      if (typeof address === 'object' && address !== null) peers.listened.add(address.port)
    })
    const server: net.Server = Reflect.apply(listen, this, args)
    return server
  }
  return {
    peers,
    restore() {
      net.Socket.prototype.connect = connect
      net.Server.prototype.listen = listen
    },
  }
}

// Bound with the unspied listen: a bind-only socket is not a listener of the test.
// oxlint-disable-next-line typescript/unbound-method
const { listen: unspiedListen } = net.Server.prototype

export async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => {
    Reflect.apply(unspiedListen, server, [0, '127.0.0.1', resolve])
  })
  const address = server.address()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  if (typeof address !== 'object' || address === null) throw new Error('no port bound')
  return address.port
}

export async function useUnreachableOllama(): Promise<() => void> {
  const port = await closedPort()
  const ollama = process.env.OLLAMA_BASE_URL
  const apiKey = process.env.ANTHROPIC_API_KEY
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${port}`
  delete process.env.ANTHROPIC_API_KEY
  clearSettingsCache()
  return () => {
    if (ollama === undefined) delete process.env.OLLAMA_BASE_URL
    else process.env.OLLAMA_BASE_URL = ollama
    if (apiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = apiKey
    clearSettingsCache()
  }
}

export function portOf(server: net.Server): number {
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('the server is not listening')
  return address.port
}
