const INDEXED = /^(\w+)\[(\d+)\]$/

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null

/** Sets `seller.name` or `lines[0].net` in place. */
export function setPath(data: object, path: string, value: unknown): void {
  const keys = path.split('.').flatMap((part): PropertyKey[] => {
    const indexed = INDEXED.exec(part)
    return indexed ? [indexed[1]!, Number(indexed[2])] : [part]
  })
  const leaf = keys.pop()!
  let node: unknown = data
  for (const key of keys) {
    if (!isObject(node)) throw new Error(`${path} has no ${String(key)}`)
    node = Reflect.get(node, key)
  }
  if (!isObject(node)) throw new Error(`${path} has no ${String(leaf)}`)
  Reflect.set(node, leaf, value)
}
