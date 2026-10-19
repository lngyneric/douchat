import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DouchatStore } from './store'
import { DouchatRuntime } from './runtime'
import { SocialClient } from './social'
import type { DesktopAuth } from './desktopAuth'
import type { ComputerProvider } from './computer'
import type { SocialMessage, SocialRoom } from '../shared/social'

const directories: string[] = []
afterEach(() => { vi.unstubAllGlobals(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const room: SocialRoom = { id: 'dm', kind: 'direct', name: '', agents: [], createdAt: '2026-09-21T00:00:00Z',
  members: [{ id: 'alice', name: 'Alice', email: 'alice@example.com', image: 'alice.png' }, { id: 'bob', name: 'Bob', email: 'bob@example.com', image: 'bob.png' }] }
function account(id: string) {
  const directory = mkdtempSync(join(tmpdir(), 'friend-inbox-')); directories.push(directory)
  const path = join(directory, 'store.db')
  const store = new DouchatStore(path)
  store.setCurrentAccountId(id)
  const auth = { getState: () => ({ status: 'signed-in', user: { id } }), getAccessToken: () => id } as unknown as DesktopAuth
  const runtime = new DouchatRuntime(store, { sessions: [], snapshot: () => [] } as unknown as ComputerProvider, () => {})
  const client = new SocialClient('https://example.com', auth, store, runtime)
  runtime.setHumanSender((conversationId, text, images, files, mentions) => client.sendMessage(conversationId, text, images, files, mentions))
  return { store, runtime, client, path }
}
function server(messages: SocialMessage[] = [], sharedRoom = room) {
  let failAfterDelivery = false
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    const authorId = String((options?.headers as Record<string, string>).Authorization).slice(7)
    if (!options?.body) return Response.json({ data: { filesVersion: 1, userId: authorId, friendships: [], rooms: [sharedRoom] } })
    const body = JSON.parse(String(options.body))
    if (body.action === 'send') {
      if (!messages.some((message) => message.id === body.id)) messages.push({ ...body, authorId, authorName: authorId, status: 'sent', createdAt: new Date().toISOString() })
      if (failAfterDelivery) { failAfterDelivery = false; throw new Error('Connection lost after delivery') }
      return Response.json({ data: {} })
    }
    const before = body.before ? messages.findIndex((message) => message.id === body.before) : messages.length
    const history = messages.slice(0, before)
    return Response.json({ data: { messages: history.slice(-100), hasMore: history.length > 100 } })
  })
  vi.stubGlobal('fetch', fetcher)
  return { messages, fetcher, loseReceipt: () => { failAfterDelivery = true } }
}

it('saves a group roster without waiting for message sync or letting an older poll overwrite it', async () => {
  const alice = account('alice')
  const sharedRoom: SocialRoom = { ...room, id: 'team', kind: 'group', name: 'Before' }
  alice.store.syncFriendConversation('alice', sharedRoom, [])
  let release!: () => void
  let started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const pending = new Promise<void>(resolve => { release = resolve })
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (!options?.body) return Response.json({ data: { userId: 'alice', friendships: [], rooms: [sharedRoom] } })
    const input = JSON.parse(String(options.body))
    if (input.action === 'messages') { started(); await pending; return Response.json({ data: { messages: [] } }) }
    if (input.action === 'rename-room') sharedRoom.name = input.name
    return Response.json({ data: {} })
  })
  vi.stubGlobal('fetch', fetcher)
  const polling = alice.client.syncInbox()
  await entered
  try {
    await alice.client.action({ action: 'rename-room', roomId: 'team', name: 'After' })
    expect(alice.store.accountConversations.find(item => item.remoteRoomId === 'team')?.name).toBe('After')
  } finally { release(); await polling }
  expect(alice.store.accountConversations.find(item => item.remoteRoomId === 'team')?.name).toBe('After')
  expect(fetcher.mock.calls.filter(([, options]) => options?.body && JSON.parse(String(options.body)).action === 'messages')).toHaveLength(1)
  expect(fetcher.mock.calls.filter(([, options]) => !options?.body)).toHaveLength(1)
  alice.store.close()
})

it('delivers text and images into the other account’s standard inbox without touching a model', async () => {
  const remote = server()
  const alice = account('alice'), bob = account('bob')
  const connect = vi.spyOn(alice.runtime, 'connect')
  await alice.client.syncInbox(); await bob.client.syncInbox()
  const aliceId = alice.store.accountConversations[0].id, bobId = bob.store.accountConversations[0].id
  await alice.runtime.sendMessage(aliceId, 'Hello Bob')
  await bob.client.syncInbox()
  expect(connect).not.toHaveBeenCalled()
  expect(bob.store.conversation(bobId)).toMatchObject({ unread: 1, person: { name: 'Alice', image: 'alice.png' } })
  expect(bob.store.messagePage(bobId, 'main').messages[0]).toMatchObject({ text: 'Hello Bob', authorId: 'alice' })
  bob.store.markConversationRead(bobId)
  bob.store.setConversationPinned(bobId, true)
  bob.store.updateConversation(bobId, { muted: true })
  await bob.client.syncInbox()
  expect(bob.store.conversation(bobId)).toMatchObject({ unread: 0, pinned: true, muted: true })
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'))
  await alice.runtime.sendMessage(aliceId, '', [{ name: 'pixel.png', mimeType: 'image/png', data: png }])
  await bob.client.syncInbox()
  const attachment = bob.store.topicMessages(bobId, 'main').at(-1)!.attachments![0]
  expect(await bob.store.attachmentDataUrl(attachment.id)).toBe('data:image/png;base64,' + Buffer.from(png).toString('base64'))
  expect(remote.messages).toHaveLength(2)
  expect(connect).not.toHaveBeenCalled()
  const reopened = new DouchatStore(bob.path)
  expect(reopened.accountConversations[0]).toMatchObject({ pinned: true, muted: true })
  reopened.setCurrentAccountId('outsider')
  expect(reopened.accountConversations).toEqual([])
})

it('retries an uncertain send without duplicates and never resurrects cleared or deleted history', async () => {
  const remote = server()
  const alice = account('alice')
  await alice.client.syncInbox()
  const id = alice.store.accountConversations[0].id
  remote.loseReceipt()
  await expect(alice.runtime.sendMessage(id, 'Once')).rejects.toThrow('Connection lost')
  await alice.runtime.sendMessage(id, 'Once')
  expect(remote.messages).toHaveLength(1)
  alice.store.clearConversation(id, 'main')
  await alice.client.syncInbox()
  expect(alice.store.topicMessages(id, 'main')).toEqual([])
  alice.store.deleteConversation(id)
  await alice.client.syncInbox()
  expect(alice.store.conversation(id)?.hidden).toBe(true)
  remote.messages.push({ id: 'new', roomId: 'dm', authorId: 'bob', authorName: 'Bob', content: 'New message',
    status: 'sent', createdAt: new Date(Date.now() + 1000).toISOString() })
  await alice.client.syncInbox()
  expect(alice.store.conversation(id)).toMatchObject({ hidden: false, unread: 1 })
  expect(alice.store.searchMessages(id, 'new')).toHaveLength(1)
  expect(alice.store.topicMessages(id, 'main')).toHaveLength(1)
})

it('imports more than a page once, keeps chronological history and uses account-specific local IDs', async () => {
  const messages: SocialMessage[] = Array.from({ length: 205 }, (_, index) => ({
    id: String(index), roomId: 'dm', authorId: 'bob', authorName: 'Bob', content: 'Message ' + index, status: 'sent',
    createdAt: new Date(Date.parse(room.createdAt) + index).toISOString()
  }))
  const remote = server(messages)
  const alice = account('alice')
  await alice.client.syncInbox()
  const id = alice.store.accountConversations[0].id
  expect(alice.store.topicMessages(id, 'main')).toHaveLength(205)
  const page = alice.store.messagePage(id, 'main')
  expect(page.hasMore).toBe(true)
  expect(page.messages.at(-1)?.text).toBe('Message 204')
  expect(alice.store.messagePage(id, 'main', page.messages[0].id).messages.at(-1)?.text).toBe('Message 154')
  remote.fetcher.mockClear()
  await alice.client.syncInbox()
  expect(remote.fetcher).toHaveBeenCalledTimes(2)
  expect(alice.store.topicMessages(id, 'main')).toHaveLength(205)
  alice.store.setCurrentAccountId('bob')
  const own = alice.store.syncFriendConversation('bob', room, messages)
  expect(own.id).not.toBe(id)
  expect(alice.store.accountConversations).toHaveLength(1)
  expect(alice.store.topicMessages(own.id, 'main')[0].authorId).toBe('user')
})

it('opens a new chat without waiting for an older inbox poll', async () => {
  const alice = account('alice')
  let releaseOld!: () => void
  let roomCreated = false
  let roomReads = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (!options?.body) {
      roomReads++
      if (roomReads === 1) {
        await new Promise<void>((resolve) => { releaseOld = resolve })
        return Response.json({ data: { userId: 'alice', rooms: [], friendships: [] } })
      }
      return Response.json({ data: { userId: 'alice', rooms: roomCreated ? [room] : [], friendships: [] } })
    }
    const body = JSON.parse(String(options.body))
    if (body.action === 'create-room') {
      roomCreated = true
      return Response.json({ data: { roomId: room.id } })
    }
    return Response.json({ data: { messages: [], hasMore: false } })
  }))
  const oldPoll = alice.client.syncInbox()
  await vi.waitFor(() => expect(roomReads).toBe(1))
  let opened = false
  const opening = alice.client.action({ action: 'create-room', kind: 'direct', friendIds: ['bob'] }).then((result) => {
    opened = true
    return result
  })
  await vi.waitFor(() => expect(roomCreated).toBe(true))
  const result = await opening
  expect(opened).toBe(true)
  releaseOld()
  await oldPoll
  expect(roomReads).toBe(2)
  expect(result.conversationId).toBe('friend:alice:dm')
  expect(alice.store.conversation(result.conversationId!)).toMatchObject({ person: { id: 'bob' }, remoteRoomId: 'dm' })
})

it('registers selected group agents concurrently and fetches no unrelated history', async () => {
  const alice = account('alice')
  const agents = ['One', 'Two', 'Three'].map(name => alice.store.createAgent({ name, role: 'Assistant', instructions: '', color: '#123456', provider: 'gateway', model: 'default' }))
  const order = agents.map(agent => `agent:${agent.id}`).reverse()
  const pending: Array<() => void> = []
  const registered: string[] = []
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    if (!options?.body) {
      reads++
      return Response.json({ data: { userId: 'alice', friendships: [], rooms: [{ ...room, id: 'new-group', kind: 'group', agents: agents.map(agent => ({ id: agent.id, localId: agent.id, ownerId: 'alice', name: agent.name })) }] } })
    }
    const input = JSON.parse(String(options.body))
    if (input.action === 'create-room') {
      expect(input.agentIds).toBeUndefined()
      return Response.json({ data: { roomId: 'new-group' } })
    }
    expect(input.action).toBe('add-agent')
    expect(input.order).toBe(order.indexOf(`agent:${input.localId}`) + 1)
    registered.push(input.localId)
    await new Promise<void>(resolve => pending.push(resolve))
    return Response.json({ data: {} })
  }))
  const creating = alice.client.action({ action: 'create-room', kind: 'group', friendIds: ['bob'], agentIds: agents.map(agent => agent.id), memberOrder: order })
  await vi.waitFor(() => expect(pending).toHaveLength(3))
  expect(reads).toBe(0)
  pending.forEach(resolve => resolve())
  const result = await creating
  expect(registered).toHaveLength(3)
  expect(reads).toBe(1)
  expect(result.snapshot?.rooms[0].agents).toHaveLength(3)
  expect(alice.store.conversation(result.conversationId!)?.remoteRoomId).toBe('new-group')
})

 it('keeps ordinary human exchanges silent even when the sender owns an agent', async () => {
  const remote = server()
  const alice = account('alice')
  const shared: SocialRoom = { ...room, id: 'shared-room', kind: 'group', agents: [
    { id: 'peer-agent', localId: 'peer', ownerId: 'bob', name: 'Peer' },
    { id: 'own-agent', localId: 'own', ownerId: 'alice', name: 'My agent' }
  ] }
  const chat = alice.store.syncFriendConversation('alice', shared, [])!
  await alice.client.sendMessage(chat.id, '大家好')
  expect(remote.messages.at(-1)?.agentId).toBeUndefined()
  await alice.client.sendMessage(chat.id, '@Bob hello')
  expect(remote.messages.at(-1)?.agentId).toBeUndefined()
  await expect(alice.client.sendMessage(chat.id, '@Peer work')).rejects.toThrow('have not synchronized')
  expect(remote.messages).toHaveLength(2)
})

it('addresses multiple agents explicitly and renders only one human message', async () => {
  const remote = server()
  const alice = account('alice')
  const shared: SocialRoom = { ...room, id: 'roll-call', kind: 'group', agents: [
    { id: 'one', localId: 'one', ownerId: 'alice', name: 'One' },
    { id: 'two', localId: 'two', ownerId: 'alice', name: 'Two' },
    { id: 'peer', localId: 'peer', ownerId: 'bob', name: 'Peer' }
  ] }
  const chat = alice.store.syncFriendConversation('alice', shared, [])!
  await alice.client.sendMessage(chat.id, '@One @Two 报个数')
  const send = remote.fetcher.mock.calls.map(([, options]) => options?.body ? JSON.parse(String(options.body)) : {}).find((body) => body.action === 'send')
  expect(send.agentIds).toEqual(['one', 'two'])
  const base: SocialMessage = { id: send.id, roomId: shared.id, authorId: 'alice', authorName: 'Alice', content: '@One @Two 报个数', status: 'succeeded', agentId: 'one', reply: 'One here', createdAt: new Date().toISOString() }
  const batch = [base, { ...base, id: 'child', parentMessageId: send.id, agentId: 'two', reply: 'Two here' }]
  alice.store.syncFriendConversation('alice', shared, batch)
  alice.store.syncFriendConversation('alice', shared, batch)
  expect(alice.store.topicMessages(chat.id, 'main').map((message) => message.text)).toEqual(['@One @Two 报个数', 'One here', 'Two here'])
})

it('attributes delegated requests and legacy cached handoffs to agents instead of their owners', () => {
  const alice = account('alice')
  const shared: SocialRoom = { ...room, id: 'delegate-room', kind: 'group', agents: [
    { id: 'source', localId: 'source', ownerId: 'alice', name: 'Source' },
    { id: 'target', localId: 'target', ownerId: 'bob', name: 'Target' }
  ] }
  const base: SocialMessage = { id: 'human', roomId: shared.id, authorId: 'alice', authorName: 'Alice', content: 'Please work', status: 'sent', createdAt: room.createdAt }
  const source: SocialMessage = { ...base, id: 'human:task:source', parentMessageId: 'human', agentId: 'source', agentName: 'Source', status: 'succeeded', reply: 'I asked Target.' }
  const child: SocialMessage = { ...base, id: `${source.id}:delegate`, authorName: 'Source', content: 'Your turn', agentId: 'target', agentName: 'Target', status: 'pending' }
  const chat = alice.store.syncFriendConversation('alice', shared, [base, source, child])!
  const delegatedId = `${chat.id}:${child.id}`
  expect(alice.store.topicMessages(chat.id, 'main').find(message => message.id === delegatedId)).toMatchObject({ authorId: 'source', authorName: 'Source', text: 'Your turn' })
  // Simulate an old installed version's cache, then a sync with no old messages.
  const legacy = alice.store.topicMessages(chat.id, 'main').find(message => message.id === delegatedId)!
  legacy.authorId = 'user'
  ;(alice.store as any).db.prepare('UPDATE messages SET data = ? WHERE id = ?').run(JSON.stringify(legacy), delegatedId)
  alice.store.syncFriendConversation('alice', shared, [])
  expect(alice.store.topicMessages(chat.id, 'main').find(message => message.id === delegatedId)?.authorId).toBe('source')
  alice.store.syncFriendConversation('alice', shared, [{ ...child, authorId: 'source', status: 'succeeded', reply: 'Target here' },
    { ...child, id: `${child.id}:delegate`, authorId: 'bob', authorName: 'Target', agentId: 'source', agentName: 'Source', content: 'Back to Source' }])
  const messages = alice.store.topicMessages(chat.id, 'main')
  expect(messages.filter(message => message.authorId === 'user').map(message => message.text)).toEqual(['Please work'])
  expect(messages.find(message => message.text === 'Back to Source')?.authorId).toBe('target')
  expect(messages.find(message => message.text === 'Target here')?.authorId).toBe('target')
})

it('syncs a shared group after its last other human is removed', async () => {
  const alice = account('alice')
  const shared: SocialRoom = { ...room, id: 'remaining-group', kind: 'group', name: 'Team', agents: [{ id: 'own', localId: 'own', ownerId: 'alice', name: 'Own' }] }
  const previous = alice.store.syncFriendConversation('alice', shared, [])
  const next = alice.store.syncFriendConversation('alice', { ...shared, members: [shared.members[0]] }, [])
  expect(next.id).toBe(previous.id)
  expect(next.name).toBe('Team')
  expect(next.agentIds).toEqual(['own'])
  expect(next.socialRoom?.members.map((member) => member.id)).toEqual(['alice'])
  expect(next.person).toBeUndefined()
})

it('refreshes existing owned agent avatars without republishing unchanged or peer profiles', async () => {
  const alice = account('alice')
  const agent = alice.store.createAgent({ name: 'Cat', role: 'Assistant', instructions: '', color: '#112233', provider: 'openai', model: 'test', avatarEmoji: '🐱' })
  const shared: SocialRoom = { ...room, id: 'avatar-room', kind: 'group', agents: [
    { id: 'owned', localId: agent.id, ownerId: 'alice', name: 'Cat' },
    { id: 'peer', localId: agent.id, ownerId: 'bob', name: 'Other Cat', avatarEmoji: '🐶' }
  ] }
  const updates: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (!options?.body) return Response.json({ data: { userId: 'alice', friendships: [], rooms: [shared] } })
    const body = JSON.parse(String(options.body))
    if (body.action === 'update-agent') {
      updates.push(body)
      Object.assign(shared.agents[0], body)
      return Response.json({ data: { agent: shared.agents[0] } })
    }
    return Response.json({ data: { messages: [] } })
  }))
  await alice.client.syncInbox()
  await alice.client.syncInbox()
  expect(updates).toHaveLength(1)
  expect(updates[0]).toMatchObject({ localId: agent.id, avatarEmoji: '🐱', avatarSeed: agent.avatarSeed })
  const synced = alice.store.accountConversations.find((item) => item.remoteRoomId === shared.id)!
  expect(synced.socialRoom?.agents[0].avatarEmoji).toBe('🐱')
  expect(synced.socialRoom?.agents[1].avatarEmoji).toBe('🐶')
})

it('syncs generated reply images even when the task message was already cached', async () => {
  const task: SocialMessage = { id: 'image-task', roomId: room.id, authorId: 'alice', authorName: 'Alice', content: 'Draw a car', agentId: 'artist', agentName: 'Artist', status: 'running', createdAt: '2026-09-21T01:00:00Z' }
  server([task])
  const bob = account('bob')
  await bob.client.syncInbox()
  task.status = 'succeeded'
  task.reply = ''
  task.replyImages = [{ name: 'car.png', mimeType: 'image/png', base64: 'iVBORw0KGgo=' }]
  await bob.client.syncInbox()
  const conversation = bob.store.accountConversations[0]
  const reply = bob.store.topicMessages(conversation.id, conversation.activeTopicId).find((message) => message.authorId === 'artist')!
  expect(reply.attachments).toHaveLength(1)
  expect(await bob.store.attachmentDataUrl(reply.attachments![0].id)).toBe('data:image/png;base64,iVBORw0KGgo=')
  await bob.client.syncInbox()
  const again = bob.store.topicMessages(conversation.id, conversation.activeTopicId).find((message) => message.authorId === 'artist')!
  expect(again.attachments).toEqual(reply.attachments)
})

it('shows a sending bubble before a slow request resolves and reconciles it without duplicates', async () => {
  const remote = server()
  const alice = account('alice')
  await alice.client.syncInbox()
  const id = alice.store.accountConversations[0].id
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = remote.fetcher.getMockImplementation()!
  remote.fetcher.mockImplementation(async (url, options) => {
    if (options?.body && JSON.parse(String(options.body)).action === 'send') await gate
    return original(url, options)
  })
  const pending = alice.client.sendMessage(id, 'Immediate')
  await vi.waitFor(() => expect(alice.store.topicMessages(id, 'main')).toHaveLength(1))
  expect(alice.store.topicMessages(id, 'main')[0]).toMatchObject({ text: 'Immediate', deliveryState: 'sending' })
  expect(remote.messages).toHaveLength(0)
  release()
  await pending
  await alice.client.syncInbox()
  expect(alice.store.topicMessages(id, 'main')).toHaveLength(1)
  expect(alice.store.topicMessages(id, 'main')[0].deliveryState).toBeUndefined()
})

it('keeps agent delivery status visible between the send receipt and task synchronization', async () => {
  const remote = server()
  const alice = account('alice')
  const group: SocialRoom = { ...room, kind: 'group', name: 'Team', agents: [{ id: 'helper', localId: 'helper', ownerId: 'alice', name: 'Helper' }] }
  const conversation = alice.store.syncFriendConversation('alice', group, [])
  const refresh = vi.spyOn(alice.client, 'syncInbox').mockResolvedValue({ userId: 'alice', friendships: [], rooms: [group] })
  await alice.client.sendMessage(conversation.id, '@Helper Hello')
  expect(alice.store.topicMessages(conversation.id, 'main')[0]).toMatchObject({ deliveryState: 'confirming' })
  const task = { ...remote.messages[0], agentName: 'Helper', status: 'pending' as const }
  alice.store.syncFriendConversation('alice', group, [task])
  const synced = alice.store.topicMessages(conversation.id, 'main')[0]
  expect(synced.deliveryState).toBeUndefined()
  expect(synced.socialTasks).toEqual([expect.objectContaining({ agentId: 'helper', status: 'pending' })])
  refresh.mockRestore()
})

it('uses incremental cursors, skips unchanged rooms and still fetches old task completions', async () => {
  const alice = account('alice')
  let revision = 'one'
  const task: SocialMessage = { id: 'old-task', roomId: room.id, authorId: 'alice', authorName: 'Alice', content: 'Work', agentId: 'agent', status: 'pending', createdAt: '2026-09-21T01:00:00Z' }
  const later: SocialMessage = { ...task, id: 'later', agentId: undefined, status: 'sent', content: 'Hi', createdAt: '2026-09-21T02:00:00Z' }
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (!options?.body) return Response.json({ data: { userId: 'alice', syncVersion: 1, friendships: [], rooms: [{ ...room, revision }] } })
    const body = JSON.parse(String(options.body))
    if (body.after) return Response.json({ data: { messages: [], updates: [{ ...task, status: 'succeeded', reply: 'Done' }], hasMore: false } })
    return Response.json({ data: { messages: [task, later], hasMore: false } })
  })
  vi.stubGlobal('fetch', fetcher)
  await alice.client.syncInbox()
  fetcher.mockClear()
  await alice.client.syncInbox()
  expect(fetcher).toHaveBeenCalledTimes(1)
  revision = 'two'
  await alice.client.syncInbox()
  const body = JSON.parse(String(fetcher.mock.calls.at(-1)![1]!.body))
  expect(body.after).toEqual({ time: '2026-09-21T01:59:55.000Z', id: '' })
  expect(body.pending).toEqual(['old-task'])
  const chat = alice.store.accountConversations[0]
  expect(alice.store.topicMessages(chat.id, 'main').map((message) => message.text)).toContain('Done')
})

it('refreshes a fast room without waiting for a slow room', async () => {
  const alice = account('alice')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (!options?.body) return Response.json({ data: { userId: 'alice', rooms: [{ ...room, id: 'slow' }, { ...room, id: 'fast' }], friendships: [] } })
    const body = JSON.parse(String(options.body))
    if (body.roomId === 'slow') await gate
    return Response.json({ data: { messages: [{ id: body.roomId, roomId: body.roomId, authorId: 'bob', authorName: 'Bob', content: 'Hello', status: 'sent', createdAt: room.createdAt }], hasMore: false } })
  }))
  const pending = alice.client.syncInbox()
  await vi.waitFor(() => expect(alice.store.accountConversations.some((chat) => chat.remoteRoomId === 'fast')).toBe(true))
  expect(alice.store.accountConversations.some((chat) => chat.remoteRoomId === 'slow')).toBe(false)
  release()
  await pending
})

it('opens an authenticated change notification request and aborts it on stop', async () => {
  const alice = account('alice')
  let notificationSignal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (!options?.body) return Response.json({ data: { userId: 'alice', syncVersion: 1, rooms: [{ ...room, revision: 'r1' }], friendships: [] } })
    const body = JSON.parse(String(options.body))
    if (body.action === 'watch') {
      expect(body.versions).toEqual({ [room.id]: 'r1' })
      expect((options.headers as Record<string, string>).Authorization).toBe('Bearer alice')
      notificationSignal = options.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => notificationSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }
    return Response.json({ data: { messages: [], tasks: [], hasMore: false } })
  }))
  alice.client.start()
  try {
    await vi.waitFor(() => expect(notificationSignal).toBeDefined())
  } finally { alice.client.stop() }
  expect(notificationSignal!.aborted).toBe(true)
})

it('applies bundled notification messages without another metadata or message request', async () => {
  const alice = account('alice')
  const snapshot = { userId: 'alice', syncVersion: 1, rooms: [{ ...room, revision: 'one' }], friendships: [] }
  const first: SocialMessage = { id: 'first', roomId: room.id, authorId: 'bob', authorName: 'Bob', content: 'First', status: 'sent', createdAt: '2026-09-21T01:00:00.000Z' }
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => options?.body
    ? Response.json({ data: { messages: [first], hasMore: false } })
    : Response.json({ data: snapshot }))
  vi.stubGlobal('fetch', fetcher)
  await alice.client.syncInbox()
  fetcher.mockClear()
  const next = { ...first, id: 'next', content: 'Instant', createdAt: '2026-09-21T01:00:01.000Z' }
  await alice.client.syncInbox(false, {
    snapshot: { ...snapshot, rooms: [{ ...room, revision: 'two' }] },
    pages: { [room.id]: { after: { time: '2026-09-21T00:59:55.000Z', id: '' }, pending: [], messages: [first, next], hasMore: false } }
  })
  expect(fetcher).not.toHaveBeenCalled()
  const chat = alice.store.accountConversations[0]
  expect(alice.store.topicMessages(chat.id, 'main').map((message) => message.text)).toEqual(['First', 'Instant'])
})

it('rejects a removal receipt when the refreshed group still contains the selected agent', async () => {
  const alice = account('alice')
  const group: SocialRoom = { ...room, kind: 'group', agents: [{ id: 'remote-agent', localId: 'local-agent', ownerId: 'alice', name: 'Helper' }] }
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (!options?.body) return Response.json({ data: { userId: 'alice', friendships: [], rooms: [group] } })
    return Response.json({ data: { messages: [] } })
  }))
  await expect(alice.client.action({ action: 'remove-members', roomId: room.id, friendIds: [], agentIds: ['remote-agent'] })).rejects.toThrow('has not been removed')
  group.agents = []
  await expect(alice.client.action({ action: 'remove-members', roomId: room.id, friendIds: [], agentIds: ['remote-agent'] })).resolves.toBeDefined()
})

it('adds only new members and returns the refreshed roster without another inbox fetch', async () => {
  const alice = account('alice')
  const existing = alice.store.createAgent({ name: 'Existing', role: 'Assistant', instructions: '', provider: 'local', model: 'default', color: '#123456' })
  const added = alice.store.createAgent({ name: 'Added', role: 'Assistant', instructions: '', provider: 'local', model: 'default', color: '#123456' })
  const group: SocialRoom = { ...room, id: 'team', kind: 'group', agents: [{ id: 'remote-existing', localId: existing.id, ownerId: 'alice', name: existing.name }] }
  const conversation = alice.store.syncFriendConversation('alice', group, [])
  const requests: Record<string, any>[] = []
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (!options?.body) return Response.json({ data: { userId: 'alice', friendships: [], rooms: [group] } })
    const input = JSON.parse(String(options.body)); requests.push(input)
    if (input.action === 'add-agent') group.agents.push({ id: 'remote-added', ownerId: 'alice', localId: input.localId, name: input.name })
    return Response.json({ data: {} })
  })
  vi.stubGlobal('fetch', fetcher)
  const result = await alice.client.action({ action: 'invite-members', conversationId: conversation.id, friendIds: ['bob', 'bob'], agentIds: [existing.id, added.id, added.id] })
  expect(requests.map(input => input.action)).toEqual(['add-agent'])
  expect(requests[0].localId).toBe(added.id)
  expect(fetcher).toHaveBeenCalledTimes(2) // One mutation and one confirmed roster.
  expect(result.snapshot?.rooms[0].agents.map(agent => agent.localId)).toEqual([existing.id, added.id])
  expect(result.snapshot?.rooms[0].members.find(person => person.id === 'bob')?.email).toBe('')
  expect(alice.store.conversation(conversation.id)?.agentIds).toContain('remote-added')
})

it('does not add friends twice when promoting a local group', async () => {
  const alice = account('alice')
  const agent = alice.store.createAgent({ name: 'Helper', role: 'Assistant', instructions: '', provider: 'local', model: 'default', color: '#123456' })
  const conversation = alice.store.createGroup({ name: 'Team', agentIds: [agent.id] })
  vi.spyOn(alice.runtime, 'snapshot').mockReturnValue({ activity: [] } as never)
  const group: SocialRoom = { ...room, id: 'team', kind: 'group', agents: [] }
  const actions: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (!options?.body) return Response.json({ data: { userId: 'alice', friendships: [], rooms: [group] } })
    const input = JSON.parse(String(options.body)); actions.push(input.action)
    if (input.action === 'create-room') { expect(input.friendIds).toEqual(['bob']); return Response.json({ data: { roomId: 'team' } }) }
    if (input.action === 'add-agent') group.agents.push({ id: 'remote-helper', localId: input.localId, ownerId: 'alice', name: input.name })
    return Response.json({ data: {} })
  }))
  const result = await alice.client.action({ action: 'invite-members', conversationId: conversation.id, friendIds: ['bob', 'bob'], agentIds: [agent.id] })
  expect(actions).toEqual(['create-room', 'add-agent'])
  expect(result.snapshot?.rooms[0].id).toBe('team')
  expect(alice.store.conversation(conversation.id)?.remoteRoomId).toBe('team')
})

it('isolates routing between two humans with multiple agents each and retains owner permissions', async () => {
  const shared: SocialRoom = { ...room, id: 'multi-owner', kind: 'group', agents: [
    { id: 'a1', localId: 'a1', ownerId: 'alice', name: 'Architect', interactionHumans: 'allow' },
    { id: 'a2', localId: 'a2', ownerId: 'alice', name: 'Reviewer', interactionHumans: 'ask' },
    { id: 'b1', localId: 'b1', ownerId: 'bob', name: 'Writer', interactionHumans: 'deny' },
    { id: 'b2', localId: 'b2', ownerId: 'bob', name: 'Analyst' }
  ] }
  const remote = server([], shared)
  const alice = account('alice'), bob = account('bob')
  const aliceConnect = vi.spyOn(alice.runtime, 'connect'), bobConnect = vi.spyOn(bob.runtime, 'connect')
  await alice.client.syncInbox(); await bob.client.syncInbox()
  const aliceChat = alice.store.accountConversations[0], bobChat = bob.store.accountConversations[0]
  await alice.runtime.greet(aliceChat.id)
  expect(alice.store.topicMessages(aliceChat.id, aliceChat.activeTopicId)).toEqual([])
  const sends = () => remote.fetcher.mock.calls.flatMap(([, options]) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {}
    return body.action === 'send' ? [body] : []
  })
  await alice.runtime.sendMessage(aliceChat.id, '@Bob What do you think?')
  await bob.client.syncInbox()
  await bob.runtime.sendMessage(bobChat.id, 'I agree. Let us proceed tomorrow.')
  await alice.runtime.sendMessage(aliceChat.id, '@all please read the update')
  expect(sends().map(body => body.agentIds)).toEqual([[], [], ['a1', 'a2']])
  const beforeRejected = sends().length
  await expect(bob.runtime.sendMessage(bobChat.id, '@all 报数')).rejects.toThrow('Only the group owner')
  expect(sends()).toHaveLength(beforeRejected)
  expect(bob.store.topicMessages(bobChat.id, bobChat.activeTopicId).some(message => message.text === '@all 报数')).toBe(false)
  await alice.runtime.sendMessage(aliceChat.id, '@Architect draft the proposal')
  await bob.client.syncInbox()
  // A human replying after an agent request must not inherit that request's recipient.
  await bob.runtime.sendMessage(bobChat.id, 'Thanks, I will handle the review myself.')
  expect(sends().at(-1).agentIds).toEqual([])
  await bob.runtime.sendMessage(bobChat.id, '@Architect @Reviewer help me review')
  expect(sends().at(-1).agentIds).toEqual(['a1', 'a2'])
  await expect(alice.runtime.sendMessage(aliceChat.id, '@Writer please help')).rejects.toThrow('disabled requests')
  await expect(alice.runtime.sendMessage(aliceChat.id, '@Analyst please help')).rejects.toThrow('not synchronized')
  await bob.runtime.sendMessage(bobChat.id, '@Writer my own request')
  expect(sends().at(-1).agentIds).toEqual(['b1'])
  expect(aliceConnect).not.toHaveBeenCalled(); expect(bobConnect).not.toHaveBeenCalled()
})

it('applies the same explicit-recipient policy to the legacy workspace and rejects removed recipients', async () => {
  const shared: SocialRoom = { ...room, kind: 'group', agents: [
    { id: 'a1', localId: 'a1', ownerId: 'alice', name: 'Helper' },
    { id: 'b1', localId: 'b1', ownerId: 'bob', name: 'Peer', interactionHumans: 'deny' }
  ] }
  const remote = server([], shared)
  const alice = account('alice')
  await alice.client.action({ action: 'send', id: 'one', roomId: shared.id, content: '@all hello' })
  await alice.client.action({ action: 'send', id: 'two', roomId: shared.id, content: 'Help please', agentId: 'a1' })
  await alice.client.action({ action: 'send', id: 'three', roomId: shared.id, content: '@Helper help please' })
  const payloads = remote.fetcher.mock.calls.flatMap(([, options]) => {
    const body = options?.body ? JSON.parse(String(options.body)) : {}
    return body.action === 'send' ? [body] : []
  })
  expect(payloads.map(body => body.agentIds)).toEqual([['a1'], ['a1'], ['a1']])
  const bob = account('bob')
  await expect(bob.client.action({ action: 'send', id: 'denied', roomId: shared.id, content: '@all hello', agentId: 'b1' })).rejects.toThrow('Only the group owner')
  await expect(alice.client.action({ action: 'send', id: 'four', roomId: shared.id, content: 'help', agentId: 'removed' })).rejects.toThrow('no longer a member')
  await expect(alice.client.action({ action: 'send', id: 'five', roomId: shared.id, content: 'help', agentId: 'b1' })).rejects.toThrow('disabled requests')
})

it('continues an answered shared-group turn and preserves its target across a lost receipt', async () => {
  const shared: SocialRoom = { ...room, id: 'follow-up', kind: 'group', agents: [
    { id: 'dr', localId: 'dr', ownerId: 'bob', name: 'Dr. Dou', interactionHumans: 'allow' }
  ] }
  const remote = server([], shared)
  const alice = account('alice')
  await alice.client.syncInbox()
  const chat = alice.store.accountConversations[0]
  await alice.runtime.sendMessage(chat.id, '@Dr. Dou 报数')
  Object.assign(remote.messages[0], { status: 'succeeded', agentName: 'Dr. Dou', reply: '要邀请其他人吗？' })
  await alice.client.syncInbox()
  remote.loseReceipt()
  await expect(alice.runtime.sendMessage(chat.id, '要啊')).rejects.toThrow('Connection lost')
  expect(remote.messages.at(-1)).toMatchObject({ content: '要啊', agentId: 'dr' })
  await alice.runtime.sendMessage(chat.id, '要啊')
  expect(remote.messages).toHaveLength(2)
  Object.assign(remote.messages[1], { status: 'succeeded', agentName: 'Dr. Dou', reply: '已邀请。' })
  await alice.client.syncInbox()
  await alice.runtime.sendMessage(chat.id, '再详细一点')
  expect(remote.messages.at(-1)).toMatchObject({ content: '再详细一点', agentId: 'dr' })
  Object.assign(remote.messages[2], { status: 'succeeded', agentName: 'Dr. Dou', reply: '详情。' })
  await alice.client.syncInbox()
  await alice.runtime.sendMessage(chat.id, '@Bob 你看看')
  expect(remote.messages.at(-1)?.agentId).toBeUndefined()
  await alice.client.syncInbox()
  await alice.runtime.sendMessage(chat.id, '好的')
  expect(remote.messages.at(-1)?.agentId).toBeUndefined()
})

it('sends a requester-scoped context reset without deleting shared messages', async () => {
  const remote = server([{ id: 'old', roomId: room.id, authorId: 'bob', authorName: 'Bob', content: 'Keep this history', status: 'sent', createdAt: room.createdAt }])
  const alice = account('alice')
  await alice.client.syncInbox()
  const chat = alice.store.accountConversations[0]
  await alice.client.resetConversationContext(chat.id)
  const request = remote.fetcher.mock.calls.map(([, options]) => options?.body ? JSON.parse(String(options.body)) : null).find(body => body?.action === 'reset-context')
  expect(request).toEqual({ action: 'reset-context', roomId: room.id })
  expect(alice.store.topicMessages(chat.id, chat.activeTopicId).some(message => message.text === 'Keep this history')).toBe(true)
  alice.store.setCurrentAccountId('bob')
  await expect(alice.client.resetConversationContext(chat.id)).rejects.toThrow('Chat not found')
})


it('delivers image-only shared group messages to another account without invoking agents', async () => {
  const remote = server([], { ...room, kind: 'group', name: 'Team' })
  const alice = account('alice'), bob = account('bob')
  await alice.client.syncInbox(); await bob.client.syncInbox()
  const aliceId = alice.store.accountConversations[0].id, bobId = bob.store.accountConversations[0].id
  const data = Buffer.from('iVBORw0KGgo=', 'base64')
  await alice.runtime.sendMessage(aliceId, '', [{ name: 'group.png', mimeType: 'image/png', data }])
  await bob.client.syncInbox()
  expect(remote.messages).toHaveLength(1)
  const sent = remote.fetcher.mock.calls.find(([, options]) => options?.body && JSON.parse(String(options.body)).action === 'send')!
  expect(JSON.parse(String(sent[1]!.body)).agentIds).toEqual([])
  const received = bob.store.topicMessages(bobId, 'main').at(-1)!
  expect(received.text).toBe('')
  expect(received.attachments).toHaveLength(1)
  expect(await bob.store.attachmentDataUrl(received.attachments![0].id)).toBe('data:image/png;base64,iVBORw0KGgo=')
  alice.store.close(); bob.store.close()
})


it('delivers files across accounts with local file cards and retries without duplicating messages', async () => {
  const remote = server([], { ...room, kind: 'group', name: 'Files' })
  const alice = account('alice'), bob = account('bob')
  await alice.client.syncInbox(); await bob.client.syncInbox()
  const a = alice.store.accountConversations[0], b = bob.store.accountConversations[0]
  const file = { name: 'logo.svg', data: Buffer.from('<svg>remote</svg>') }
  remote.loseReceipt()
  await expect(alice.runtime.sendMessage(a.id, '', [], [file])).rejects.toThrow('Connection lost')
  await alice.runtime.sendMessage(a.id, '', [], [file])
  await bob.client.syncInbox()
  expect(remote.messages).toHaveLength(1)
  expect(remote.messages[0].content).toBe('')
  expect(remote.messages[0].files).toEqual([{ name: file.name, base64: file.data.toString('base64') }])
  const first = bob.store.topicMessages(b.id, 'main').at(-1)!
  expect(first.text).toContain('[logo.svg](<douchat-file:')
  const path = (await import('node:url')).fileURLToPath(/<([^>]+)>/.exec(first.text)![1].replace('douchat-file:', 'file:'))
  expect(await bob.store.ownedDocumentPath(path)).toBe(path)
  expect(await (await import('node:fs/promises')).readFile(path, 'utf8')).toBe('<svg>remote</svg>')
  await bob.client.syncInbox()
  expect(bob.store.topicMessages(b.id, 'main').at(-1)!.text).toBe(first.text)
  alice.store.close(); bob.store.close()
})


it('preserves received reply file cards across later inbox refreshes', async () => {
  server([{ id: 'file-reply', roomId: room.id, authorId: 'alice', authorName: 'Alice', content: 'Make a file', agentId: 'helper', agentName: 'Helper', status: 'succeeded', reply: '', replyFiles: [{ name: 'result.csv', base64: Buffer.from('a,b\n1,2').toString('base64') }], createdAt: room.createdAt }])
  const bob = account('bob')
  await bob.client.syncInbox()
  const chat = bob.store.accountConversations[0]
  const reply = bob.store.topicMessages(chat.id, 'main').find(message => message.id.endsWith(':reply'))!
  expect(reply.text).toContain('[result.csv](<douchat-file:')
  await bob.client.syncInbox()
  expect(bob.store.topicMessages(chat.id, 'main').find(message => message.id === reply.id)!.text).toBe(reply.text)
  bob.store.close()
})

it('carries the selected member ID through runtime, remote send and a lost-receipt retry', async () => {
  const agents = [
    { id: 'first', localId: 'a', ownerId: 'alice', name: 'Dr. Dou' },
    { id: 'second', localId: 'b', ownerId: 'bob', name: 'Dr. Dou', interactionHumans: 'allow' as const }
  ]
  const remote = server([], { ...room, kind: 'group', agents })
  const alice = account('alice')
  await alice.client.syncInbox()
  const chat = alice.store.accountConversations[0]
  const selections = [{ id: 'second', name: 'Dr. Dou', start: 0, end: 8 }]
  remote.loseReceipt()
  await expect(alice.runtime.sendMessage(chat.id, '@Dr. Dou help', [], [], selections)).rejects.toThrow('Connection lost')
  await alice.runtime.sendMessage(chat.id, '@Dr. Dou help', [], [], selections)
  const sends = remote.fetcher.mock.calls.flatMap(([, options]) => options?.body ? [JSON.parse(String(options.body))] : []).filter(body => body.action === 'send')
  expect(sends.map(body => body.agentIds)).toEqual([['second'], ['second']])
  expect(sends[0].id).toBe(sends[1].id)
  expect(sends[0].content).toBe('@Dr. Dou help')
  alice.store.close()
})

it('shares how far a friend chat was read and applies a later mark from another client', () => {
  const alice = account('alice')
  const at = (minute: number) => `2026-09-21T00:0${minute}:00Z`
  const message = (id: string, minute: number): SocialMessage => ({ id, roomId: 'dm', authorId: 'bob', authorName: 'Bob', content: id, status: 'sent', createdAt: at(minute) } as SocialMessage)
  const chat = alice.store.syncFriendConversation('alice', room, [message('one', 1), message('two', 2), message('three', 3)])
  expect(alice.store.conversation(chat.id)?.unread).toBe(3)
  // Nothing read here yet, so there is no mark to share.
  expect(alice.store.roomReadMarks()).toEqual([])

  // The web app read through the second message: only the third stays unread.
  expect(alice.store.applyRoomRead({ roomId: 'dm', readAt: Date.parse(at(2)) })).toBe(true)
  expect(alice.store.conversation(chat.id)).toMatchObject({ unread: 1, readAt: Date.parse(at(2)) })
  // An older mark changes nothing.
  expect(alice.store.applyRoomRead({ roomId: 'dm', readAt: Date.parse(at(1)) })).toBe(false)

  // Read here: the room counts as read through its latest activity.
  alice.store.markConversationRead(chat.id)
  const [mark] = alice.store.roomReadMarks()
  expect(mark.roomId).toBe('dm')
  expect(mark.readAt).toBeGreaterThanOrEqual(Date.parse(at(3)))
})
