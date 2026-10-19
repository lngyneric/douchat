import type { SelectedMention } from '../shared/bot/mentions'
import { addressesEveryone } from '../shared/bot/mentions'
import type { SocialAction, SocialImage, SocialMessage, SocialResult, SocialRoom, SocialSnapshot } from '../shared/social'
import { socialFollowUpTarget } from '../shared/socialFollowUp'
import { checkHumanAgentTargets, privacySafeSocialSnapshot, rendererSocialSnapshot, sharedGroupReplyTargets } from '../shared/socialRules'
import type { ChatMessage, Conversation, MessageAttachment } from '../shared/types'

/**
 * Friends' chats and shared groups in the web app. They already live on the
 * Douchat service (they are not part of account sync), so the web app reads
 * them the way a desktop does: the room list, then each room's messages, and
 * sends through the same `send` action. Agents in a group still answer from
 * their owners' desktops.
 */

type Service = <T>(path: string, init?: RequestInit) => Promise<T>
const POLL_MS = 3000
const TOPIC_ID = 'main'
const READ_KEY = 'douchat.web.socialRead'
const SEEN_KEY = 'douchat.web.socialSeen'
const PREFS_KEY = 'douchat.web.socialPrefs'
/** Inbox choices for service rooms; a desktop keeps its own, as it does today. */
export type RoomPrefs = Partial<Pick<Conversation, 'pinned' | 'muted' | 'hidden' | 'savedToContacts'>>
const stored = <T>(key: string): T => { try { return JSON.parse(localStorage.getItem(key) ?? '{}') as T } catch { return {} as T } }

interface RoomState { revision?: string; messages: Map<string, SocialMessage>; loaded: boolean }

export class WebSocial {
  private snapshot?: SocialSnapshot
  private readonly rooms = new Map<string, RoomState>()
  /** Messages sent here, shown until the service confirms them. */
  private readonly sending = new Map<string, ChatMessage>()
  private readonly attachments = new Map<string, string>()
  private readRooms = stored<Record<string, number>>(READ_KEY)
  private prefs = stored<Record<string, RoomPrefs>>(PREFS_KEY)
  /** When this browser first saw each room, for rooms no client has read yet. */
  private seenRooms = stored<Record<string, number>>(SEEN_KEY)
  /** Read marks shared with the desktop through account sync (see RoomReadMark). */
  sharedReads?: { get: (roomId: string) => number | undefined; mark: (roomId: string, readAt: number) => void }
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(private readonly service: Service, private readonly ownerId: () => string | undefined, private readonly onChange: () => void) {}

  start(): void { void this.poll() }
  stop(): void { this.stopped = true; clearTimeout(this.timer) }

  getSnapshot(): SocialSnapshot { return this.snapshot ?? { userId: this.ownerId() ?? '', friendships: [], rooms: [] } }
  attachmentData(id: string): string | undefined { return this.attachments.get(id) }
  roomOf(conversationId: string): SocialRoom | undefined {
    return this.snapshot?.rooms.find((room) => conversationIdFor(this.ownerId() ?? '', room) === conversationId)
  }

  private async poll(): Promise<void> {
    if (this.stopped) return
    try { await this.refresh() } catch { /* Next poll retries. */ }
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), POLL_MS)
  }

  async refresh(): Promise<void> {
    const snapshot = rendererSocialSnapshot(privacySafeSocialSnapshot(await this.service<SocialSnapshot>('/api/desktop-auth/social')))
    if (snapshot.userId !== this.ownerId()) return
    this.snapshot = snapshot
    await Promise.all(snapshot.rooms.map((room) => this.syncRoom(room).catch(() => undefined)))
    this.onChange()
  }

  /** Load a room's history once, then only what changed since the room's last revision. */
  private async syncRoom(room: SocialRoom): Promise<void> {
    const state: RoomState = this.rooms.get(room.id) ?? { messages: new Map(), loaded: false }
    this.rooms.set(room.id, state)
    if (state.loaded && room.revision && state.revision === room.revision) return
    let before: string | undefined
    for (let pages = 0; pages < (state.loaded ? 1 : 10); pages++) {
      const page = await this.action({ action: 'messages', roomId: room.id, ...(before ? { before } : {}) })
      const batch = page.messages ?? []
      let known = false
      for (const message of [...batch, ...(page.updates ?? [])]) {
        if (state.messages.has(message.id) && JSON.stringify(state.messages.get(message.id)) === JSON.stringify(message)) known = true
        state.messages.set(message.id, message)
        this.sending.delete(`${conversationIdFor(this.ownerId() ?? '', room)}:${message.id}`)
      }
      if (!page.hasMore || !batch.length || (state.loaded && known)) break
      before = batch[0].id
    }
    state.loaded = true
    state.revision = room.revision
  }

  action(input: SocialAction | Record<string, unknown>): Promise<SocialResult> {
    return this.service<SocialResult>('/api/desktop-auth/social', { method: 'POST', body: JSON.stringify(input) })
  }

  /** The service rooms as inbox conversations and their messages, shaped like a desktop's copy. */
  view(): { conversations: Conversation[]; messages: ChatMessage[] } {
    const ownerId = this.ownerId()
    if (!ownerId || !this.snapshot) return { conversations: [], messages: [] }
    const conversations: Conversation[] = []
    const messages: ChatMessage[] = []
    for (const room of this.snapshot.rooms) {
      if (room.kind === 'agent' || !room.members.some((member) => member.id === ownerId)) continue
      const id = conversationIdFor(ownerId, room)
      const person = room.members.find((member) => member.id !== ownerId)
      if (room.kind === 'direct' && !person) continue
      const createdAt = Date.parse(room.createdAt)
      const own: ChatMessage[] = []
      const roomMessages = [...(this.rooms.get(room.id)?.messages.values() ?? [])]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || Number(Boolean(a.parentMessageId)) - Number(Boolean(b.parentMessageId)) || a.id.localeCompare(b.id))
      const byId = new Map<string, ChatMessage>()
      for (const message of roomMessages) {
        const messageId = `${id}:${message.id}`
        const at = Date.parse(message.createdAt)
        if (!message.parentMessageId && !byId.has(messageId)) {
          const chat: ChatMessage = {
            id: messageId, conversationId: id, topicId: TOPIC_ID, authorId: message.authorId === ownerId ? 'user' : message.authorId,
            authorName: message.authorName, text: message.content, kind: 'message', createdAt: at,
            ...this.images(messageId, message.images)
          }
          byId.set(messageId, chat)
          own.push(chat)
        }
        if (message.agentId) {
          const parent = byId.get(`${id}:${message.parentMessageId || message.id}`)
          if (parent) parent.socialTasks = [...(parent.socialTasks ?? []).filter((task) => task.id !== message.id), { id: message.id, agentId: message.agentId, agentName: message.agentName || '', status: message.status }]
        }
        if (message.reply || message.replyImages?.length) {
          own.push({
            id: `${messageId}:reply`, conversationId: id, topicId: TOPIC_ID, authorId: message.agentId ?? 'system', authorName: message.agentName || '',
            text: message.reply ?? '', kind: 'message', createdAt: at, ...this.images(`${messageId}:reply`, message.replyImages),
            ...(message.status === 'failed' ? { error: message.reply } : {})
          })
        }
      }
      for (const pending of this.sending.values()) if (pending.conversationId === id) own.push(pending)
      const updatedAt = Math.max(createdAt, ...own.map((message) => message.createdAt))
      const readAt = this.readAt(room.id)
      conversations.push({
        id, ownerId, type: room.kind, name: room.kind === 'direct' ? person!.name : room.name, remoteRoomId: room.id,
        ...(room.kind === 'direct' ? { person } : { socialRoom: room }),
        agentIds: room.kind === 'group' ? room.agents.map((agent) => agent.id) : [],
        ...this.prefs[room.id],
        topics: [{ id: TOPIC_ID, title: '', createdAt, updatedAt }], activeTopicId: TOPIC_ID,
        unread: own.filter((message) => message.authorId !== 'user' && message.createdAt > readAt).length, readAt, createdAt, updatedAt
      })
      messages.push(...own)
    }
    return { conversations, messages }
  }

  private images(id: string, images?: SocialImage[]): { attachments?: MessageAttachment[] } {
    if (!images?.length) return {}
    return {
      attachments: images.map((image, index) => {
        const attachmentId = `${id}:image:${index}`
        this.attachments.set(attachmentId, `data:${image.mimeType};base64,${image.base64}`)
        return { id: attachmentId, kind: 'image', name: image.name, mimeType: image.mimeType, size: Math.floor(image.base64.length * 3 / 4) }
      })
    }
  }

  /**
   * How far a room has been read: the later of the synced mark (shared with the
   * desktop) and this browser's own. A room no client ever marked counts as read
   * up to when this browser first saw it, so signing in to the web app does not
   * turn a room's whole history unread.
   */
  private readAt(roomId: string): number {
    const marks = [this.sharedReads?.get(roomId), this.readRooms[roomId]].filter((value): value is number => typeof value === 'number')
    if (marks.length) return Math.max(...marks)
    if (this.seenRooms[roomId] === undefined) {
      this.seenRooms[roomId] = Date.now()
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(this.seenRooms)) } catch { /* This tab only. */ }
    }
    return this.seenRooms[roomId]
  }

  markRead(conversationId: string): void {
    const room = this.roomOf(conversationId)
    if (!room) return
    const now = Date.now()
    this.readRooms[room.id] = now
    try { localStorage.setItem(READ_KEY, JSON.stringify(this.readRooms)) } catch { /* This tab only. */ }
    this.sharedReads?.mark(room.id, now)
    this.onChange()
  }

  setPrefs(conversationId: string, prefs: RoomPrefs): void {
    const room = this.roomOf(conversationId)
    if (!room) throw new Error('Chat not found')
    this.prefs[room.id] = { ...this.prefs[room.id], ...prefs }
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs)) } catch { /* This tab only. */ }
    this.onChange()
  }

  /** Send text to a friend or group, addressing agents the way the desktop does. */
  async send(conversationId: string, content: string, history: ChatMessage[], mentions?: SelectedMention[]): Promise<void> {
    const ownerId = this.ownerId()
    const room = this.roomOf(conversationId)
    if (!ownerId || !room) throw new Error('Chat not found')
    const explicit = room.kind !== 'group' && addressesEveryone(content) ? [] : sharedGroupReplyTargets(content, room.agents, room.members, ownerId, mentions)
    const conversation = this.view().conversations.find((item) => item.id === conversationId)
    const followUp = explicit.length ? undefined : socialFollowUpTarget(conversation, history, content)
    const agentIds = explicit.length ? explicit : followUp ? [followUp.id] : []
    checkHumanAgentTargets(agentIds, room.agents, ownerId)
    const id = crypto.randomUUID()
    const local: ChatMessage = { id: `${conversationId}:${id}`, conversationId, topicId: TOPIC_ID, authorId: 'user', authorName: 'You', text: content, kind: 'message', createdAt: Date.now(), deliveryState: 'sending' }
    this.sending.set(local.id, local)
    this.onChange()
    try {
      await this.action({ action: 'send', roomId: room.id, id, content, agentId: agentIds[0], agentIds } as Record<string, unknown>)
      this.sending.set(local.id, { ...local, deliveryState: agentIds.length ? 'confirming' : undefined })
    } catch (error) {
      this.sending.set(local.id, { ...local, deliveryState: 'failed' })
      this.onChange()
      throw error
    }
    await this.refresh().catch(() => undefined)
  }
}

/** The same local id a desktop gives the room, so links work across clients. */
export function conversationIdFor(ownerId: string, room: SocialRoom): string {
  return `${room.kind === 'direct' ? 'friend' : 'shared'}:${ownerId}:${room.id}`
}
