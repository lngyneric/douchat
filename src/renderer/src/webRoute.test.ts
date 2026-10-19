import { describe, expect, it } from 'vitest'
import { conversationCode, readRoute, resolveConversation, routePath } from './webRoute'

describe('web app addresses', () => {
  const conversations = [{ id: 'direct-system-admin-43c923d0-c05a-480f-a5d6-278b96799865' }, { id: 'friend:owner:dm-9b4fb0cd6c078adee754905' }]

  it('names a conversation by a short code every device derives the same way', () => {
    const code = conversationCode(conversations[0].id)
    expect(code).toMatch(/^[0-9a-z]{1,11}$/)
    expect(conversationCode(conversations[0].id)).toBe(code)
    expect(conversationCode(conversations[1].id)).not.toBe(code)
    expect(routePath({ view: 'chats', conversationId: conversations[0].id }, '/app')).toBe(`/app/chat/${code}`)
    expect(resolveConversation(code, conversations)).toBe(conversations[0].id)
  })

  it('still opens older links that carry the full id, and ignores unknown codes', () => {
    expect(resolveConversation(conversations[1].id, conversations)).toBe(conversations[1].id)
    expect(resolveConversation('unknown', conversations)).toBeUndefined()
  })

  it('reads pages under /app and at the root of app.douchat.ai', () => {
    expect(readRoute('/app/chat/abc')).toEqual({ view: 'chats', conversationId: 'abc' })
    expect(readRoute('/chat/abc')).toEqual({ view: 'chats', conversationId: 'abc' })
    expect(readRoute('/app/contacts')).toEqual({ view: 'contacts' })
    expect(readRoute('/app/settings/general')).toEqual({ view: 'chats', settingsTab: 'general' })
    expect(readRoute('/app/settings/nope')).toEqual({ view: 'chats', settingsTab: 'profile' })
    expect(routePath({ view: 'contacts' }, '')).toBe('/contacts')
  })
})
