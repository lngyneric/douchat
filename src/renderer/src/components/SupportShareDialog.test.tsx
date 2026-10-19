// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SupportShare } from '../../../shared/cloudSync'
import type { Conversation } from '../../../shared/types'
vi.mock('../preferences', () => ({ t: (value: string) => value }))
vi.mock('./NativeDialog', () => ({ NativeDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }))
import { SupportShareDialog } from './SupportShareDialog'

let root: Root
let container: HTMLDivElement
const supportShares = vi.fn()
const createSupportShare = vi.fn()
const revokeSupportShare = vi.fn()
const conversation = { id: 'chat-1', name: 'Bug', type: 'direct', agentIds: [], topics: [], activeTopicId: '', unread: 0, readAt: 0, createdAt: 0, updatedAt: 0 } as Conversation
const share = (patch: Partial<SupportShare> = {}): SupportShare => ({ id: 's1', conversationId: 'chat-1', note: '', createdAt: 1, expiresAt: Date.now() + 1000, status: 'active', views: 0, lastViewedAt: null, ...patch })

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  supportShares.mockReset().mockResolvedValue([])
  createSupportShare.mockReset()
  revokeSupportShare.mockReset().mockResolvedValue(undefined)
  window.douchat = { supportShares, createSupportShare, revokeSupportShare } as unknown as typeof window.douchat
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
const render = async () => { await act(async () => root.render(<SupportShareDialog conversation={conversation} onClose={() => {}} />)) }
const click = async (label: string) => { await act(async () => { Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label)!.click() }) }

it('shares for the chosen duration, shows views, and revokes', async () => {
  await render()
  expect(supportShares).toHaveBeenCalledWith('chat-1')
  expect(container.textContent).toContain('Not shared with support')

  createSupportShare.mockResolvedValue(share({ note: 'Crash on send' }))
  await act(async () => {
    const note = container.querySelector('textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(note, '  Crash on send ')
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await click('7 days')
  await click('Share')
  expect(createSupportShare).toHaveBeenCalledWith('chat-1', 168, 'Crash on send')
  expect(container.textContent).toContain('Crash on send')
  expect(container.textContent).toContain('Not viewed yet')

  await click('Revoke')
  expect(revokeSupportShare).toHaveBeenCalledWith('s1')
  expect(container.textContent).toContain('Revoked')
  expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === 'Revoke')).toBe(false)
})

it('reports how many times support opened a share', async () => {
  supportShares.mockResolvedValue([share({ views: 2, lastViewedAt: Date.now() })])
  await render()
  expect(container.textContent).toContain('Viewed 2 times')
})
