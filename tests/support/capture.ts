import { vi } from 'vitest'

export interface Captured {
  code: number
  stdout: string
  stderr: string
}

export async function capturing(run: () => Promise<number>): Promise<Captured> {
  let stdout = ''
  let stderr = ''
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  try {
    const code = await run()
    return { code, stdout, stderr }
  } finally {
    err.mockRestore()
    out.mockRestore()
  }
}
