import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeRpcValue, DESKTOP_RPC, encodeRpcValue, withoutSnapshots } from './desktopRpc'

describe('desktop calls from the web app', () => {
  it('uses the same channel as the desktop window for every method', () => {
    const preload = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')
    for (const [method, channel] of Object.entries(DESKTOP_RPC)) {
      // The method's own entry only: stop before the next `  name:` line.
      const match = new RegExp(`\\n  ${method}:(?:(?!\\n  \\w+:)[\\s\\S])*?ipcRenderer\\.invoke\\('([a-z0-9:-]+)'`).exec(preload)
      expect(match?.[1], method).toBe(channel)
    }
  })

  it('carries bytes through JSON and leaves snapshots out of answers', () => {
    const bytes = new Uint8Array([0, 1, 254, 255])
    const decoded = decodeRpcValue(JSON.parse(JSON.stringify(encodeRpcValue(['x', { data: bytes }])))) as [string, { data: Uint8Array }]
    expect(decoded[0]).toBe('x')
    expect([...decoded[1].data]).toEqual([0, 1, 254, 255])
    const snapshot = { agents: [], conversations: [], messages: [] }
    expect(withoutSnapshots(snapshot)).toBeNull()
    expect(withoutSnapshots({ snapshot, conversationId: 'c' })).toEqual({ conversationId: 'c' })
    expect(withoutSnapshots(['a'])).toEqual(['a'])
  })
})
