import { endianness } from 'node:os'

// The .npy format for C-order little-endian float16 arrays.
const MAGIC = Buffer.from([0x93, ...Buffer.from('NUMPY', 'latin1')])
const ARRAY_ALIGN = 64
const GROWTH_AXIS_MAX_DIGITS = 21
const DESCR = '<f2'

// Typed arrays use the host byte order and '<f2' is little-endian.
if (endianness() !== 'LE') throw new Error('the .npy code needs a little-endian host')

export interface Float16Npy {
  shape: number[]
  data: Float16Array
}

/** repr() of a tuple of ints. */
export function shapeRepr(shape: readonly number[]): string {
  if (shape.length === 1) return `(${shape[0]},)`
  return `(${shape.join(', ')})`
}

/** float32 rows rounded to float16. */
export function float16Rows(rows: readonly Float32Array[]): Float16Npy {
  const cols = rows[0]?.length ?? 0
  const data = new Float16Array(rows.length * cols)
  rows.forEach((row, r) => {
    if (row.length !== cols) throw new Error('rows differ in length')
    data.set(row, r * cols)
  })
  return { shape: rows.length === 0 ? [0] : [rows.length, cols], data }
}

/** The .npy bytes of a float16 array, without pickle. */
export function npyBytes(array: Float16Npy): Buffer {
  const count = array.shape.reduce((a, b) => a * b, 1)
  if (count !== array.data.length) throw new Error('shape and data differ in size')
  let header = `{'descr': '${DESCR}', 'fortran_order': False, 'shape': ${shapeRepr(array.shape)}, }`
  if (array.shape.length > 0) {
    header += ' '.repeat(GROWTH_AXIS_MAX_DIGITS - String(array.shape[0]).length)
  }
  const hlen = Buffer.byteLength(header, 'latin1') + 1
  const padlen = ARRAY_ALIGN - ((MAGIC.length + 2 + 2 + hlen) % ARRAY_ALIGN)
  if (hlen + padlen > 0xffff) throw new Error(`Header length ${hlen} too big for version=(1, 0)`)
  const prefix = Buffer.alloc(MAGIC.length + 4)
  MAGIC.copy(prefix)
  prefix.writeUInt8(1, MAGIC.length)
  prefix.writeUInt8(0, MAGIC.length + 1)
  prefix.writeUInt16LE(hlen + padlen, MAGIC.length + 2)
  const body = Buffer.from(array.data.buffer, array.data.byteOffset, array.data.byteLength)
  return Buffer.concat([prefix, Buffer.from(`${header}${' '.repeat(padlen)}\n`, 'latin1'), body])
}

const HEADER = new RegExp(
  String.raw`^\{\s*'descr':\s*'([^']*)',\s*'fortran_order':\s*(True|False),\s*'shape':\s*\(((?:\s*\d+\s*,)*(?:\s*\d+\s*)?)\),?\s*\}\s*$`,
)

/** Parses a C-order float16 .npy array, without pickle. */
export function parseNpy(bytes: Uint8Array): Float16Npy {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.length < MAGIC.length + 2 || !buffer.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('the magic string is not correct; expected a .npy file')
  }
  const major = buffer[MAGIC.length]!
  const minor = buffer[MAGIC.length + 1]!
  if (minor !== 0 || major < 1 || major > 3) {
    throw new Error(
      `we only support format version (1,0), (2,0), and (3,0), not (${major}, ${minor})`,
    )
  }
  const lengthAt = MAGIC.length + 2
  const wide = major > 1
  const headerLength = wide ? buffer.readUInt32LE(lengthAt) : buffer.readUInt16LE(lengthAt)
  const start = lengthAt + (wide ? 4 : 2)
  const header = buffer.toString(major === 3 ? 'utf8' : 'latin1', start, start + headerLength)
  const match = HEADER.exec(header)
  if (match === null) throw new Error(`Cannot parse header: ${JSON.stringify(header)}`)
  const [, descr, fortranOrder, dims] = match
  if (descr !== DESCR || fortranOrder !== 'False') {
    throw new Error(
      `only C-order ${DESCR} arrays are read, not ${descr} fortran_order=${fortranOrder}`,
    )
  }
  const shape = dims!
    .split(',')
    .map((dim) => dim.trim())
    .filter((dim) => dim !== '')
    .map(Number)
  const count = shape.reduce((a, b) => a * b, 1)
  const offset = start + headerLength
  if (buffer.length - offset < count * 2) {
    throw new Error(`the file holds fewer than the ${count} values of shape ${shapeRepr(shape)}`)
  }
  const data = new Float16Array(count)
  new Uint8Array(data.buffer).set(buffer.subarray(offset, offset + count * 2))
  return { shape, data }
}
