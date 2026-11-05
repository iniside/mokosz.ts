import net from 'node:net'

const LOOPBACK = /^(localhost|::1|127(\.\d{1,3}){3})$/

/** Only loopback may be connected to: no test reaches the network. */
// oxlint-disable-next-line typescript/unbound-method
const { connect } = net.Socket.prototype

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  const [first, second] = args
  const options: unknown = Array.isArray(first) ? first[0] : first
  let host: unknown
  if (typeof options === 'object' && options !== null) {
    host = Reflect.get(options, 'path') === undefined ? Reflect.get(options, 'host') : undefined
  } else if (typeof options === 'string' && Number.isNaN(Number(options))) {
    host = undefined
  } else {
    host = second
  }
  if (typeof host === 'string' && !LOOPBACK.test(host)) {
    throw new Error(`network access in tests: ${host}`)
  }
  const socket: net.Socket = Reflect.apply(connect, this, args)
  return socket
}
