import type { SocialSnapshot } from '../../../shared/social'
import { t, tr } from '../preferences'
import { ChevronRight, Search, Star, UsersRound, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { AgentConfig, AppSnapshot, Conversation } from '../../../shared/types'
import { contactSections, matchesContactQuery } from '../../../shared/bot/contacts'
import { OverlayScrollbar } from './OverlayScrollbar'
import { AgentAvatar, ConversationAvatar, UserAvatar, SidebarResizer, agentDisplayName, agentSourceLabel } from './common'

export type ContactSelection = { kind: 'bot'; id: string } | { kind: 'group'; id: string } | { kind: 'friend' | 'friend-chat' | 'friend-requests' | 'social-group' | 'new-social-group'; id: string }

export function ContactList({
  snapshot,
  selected,
  social,
  socialError,
  onSelect
}: {
  snapshot: AppSnapshot
  social?: SocialSnapshot
  socialError?: string
  selected?: ContactSelection
  onSelect: (selection: ContactSelection) => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const [builtInOpen, setBuiltInOpen] = useState(true)
  const [groupsOpen, setGroupsOpen] = useState(false)
  const [botsOpen, setBotsOpen] = useState(true)
  const [friendsOpen, setFriendsOpen] = useState(true)
  const friends = (social?.friendships ?? []).filter((item) => matchesContactQuery(`${item.person.name} ${item.status === 'accepted' ? item.person.email : ''}`, query))
  const sharedGroups: NonNullable<typeof social>['rooms'] = []

  const groups = useMemo(
    () =>
      snapshot.conversations
        .filter((conversation) => conversation.type === 'group' && conversation.savedToContacts === true && matchesContactQuery(conversation.name, query))
        .sort((left, right) => left.name.localeCompare(right.name)),
    [snapshot.conversations, query]
  )

  const pinnedBotIds = useMemo(
    () =>
      new Set(
        snapshot.conversations
          .filter((conversation) => conversation.type === 'direct' && conversation.pinned)
          .map((conversation) => conversation.agentIds[0])
      ),
    [snapshot.conversations]
  )

  const matchingAgents = useMemo(
    () => snapshot.agents.filter((agent) => matchesContactQuery(`${agent.name} ${agentDisplayName(agent)}`, query)),
    [snapshot.agents, query, document.documentElement.lang]
  )
  const hasBuiltIn = snapshot.agents.some((agent) => agent.systemRole === 'admin')
  const builtIn = matchingAgents.filter((agent) => agent.systemRole === 'admin')
  const bots = matchingAgents.filter((agent) => agent.systemRole !== 'admin')
  const starred = bots.filter((agent) => pinnedBotIds.has(agent.id))
  const sections = useMemo(() => contactSections(bots.filter((agent) => !pinnedBotIds.has(agent.id))), [bots, pinnedBotIds])

  const botRow = (agent: AgentConfig): ReactElement => (
    <button
      key={agent.id}
      className={`contact-row ${selected?.kind === 'bot' && selected.id === agent.id ? 'active' : ''}`}
      onClick={() => onSelect({ kind: 'bot', id: agent.id })}
    >
      <AgentAvatar agent={agent} size={34} />
      <span className="contact-row-copy">
        <strong>{agentDisplayName(agent)}</strong>
        <small>{agentSourceLabel(agent)}</small>
      </span>
      <span className={`contact-state ${snapshot.agentStatuses[agent.id] ?? 'idle'}`} />
    </button>
  )

  const groupRow = (conversation: Conversation): ReactElement => (
    <button
      key={conversation.id}
      className={`contact-row ${selected?.kind === 'group' && selected.id === conversation.id ? 'active' : ''}`}
      onClick={() => onSelect({ kind: 'group', id: conversation.id })}
    >
      <ConversationAvatar conversation={conversation} agents={snapshot.agents} userName={snapshot.userName} userAvatar={snapshot.userAvatar} size={34} />
      <span className="contact-row-copy">
        <strong>{conversation.name}</strong>
        <small>{conversation.agentIds.length + 1} members</small>
      </span>
    </button>
  )

  return (
    <aside className="sidebar contacts-sidebar">
      <SidebarResizer />
      <div className="sidebar-titlebar window-drag">
        <div className="search-box no-drag">
          <Search size={15} />
          <input data-app-search aria-keyshortcuts="Meta+F Control+F" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Search contacts')} />
          {query && (
            <button onClick={() => setQuery('')} aria-label={t('Clear search')}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="contact-list" ref={listRef}>
        {hasBuiltIn && <>
          <button className="contact-folder" onClick={() => setBuiltInOpen((open) => !open)} aria-expanded={builtInOpen}>
            <ChevronRight size={15} className={builtInOpen ? 'open' : ''} />
            <span>{t('Built-in')}</span>
            <em>{builtIn.length}</em>
          </button>
          {builtInOpen && builtIn.length > 0 && (
            <div className="contact-folder-body contact-built-in">
              {builtIn.map(botRow)}
            </div>
          )}
        </>}

        <button className="contact-folder" onClick={() => setGroupsOpen((open) => !open)} aria-expanded={groupsOpen}>
          <ChevronRight size={15} className={groupsOpen ? 'open' : ''} />
          <span>{t('Group chats')}</span>
          <em>{groups.length + sharedGroups.length}</em>
        </button>
        {groupsOpen && (
          <div className="contact-folder-body">
            {groups.map(groupRow)}
            {sharedGroups.map((room) => <button key={room.id} className={`contact-row ${selected?.kind === 'social-group' && selected.id === room.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'social-group', id: room.id })}><UsersRound size={28} /><span className="contact-row-copy"><strong>{room.name}</strong><small>{tr('{count} members', { count: room.members.length })}</small></span></button>)}
          </div>
        )}

        <button className="contact-folder" onClick={() => setBotsOpen((open) => !open)} aria-expanded={botsOpen}>
          <ChevronRight size={15} className={botsOpen ? 'open' : ''} />
          <span>{t('Agents')}</span>
          <em>{bots.length}</em>
        </button>
        {botsOpen && (
          <div className="contact-folder-body">
            {starred.length > 0 && (
              <>
                <div className="contact-letter starred">
                  <Star size={12} />
                  <span>{t('Starred')}</span>
                </div>
                {starred.map(botRow)}
              </>
            )}
            {sections.map((section) => (
              <div key={section.letter}>
                <div className="contact-letter">{section.letter}</div>
                {section.contacts.map(botRow)}
              </div>
            ))}
            {!bots.length && <p className="empty-search">{tr('No agents match “{query}”.', { query: query.trim() })}</p>}
          </div>
        )}
        <button className="contact-folder" onClick={() => setFriendsOpen((open) => !open)} aria-expanded={friendsOpen}>
          <ChevronRight size={15} className={friendsOpen ? 'open' : ''} /><span>{t('Friends')}</span><em>{friends.length}</em>
        </button>
        {friendsOpen && <div className="contact-folder-body contact-friends">
          {friends.map((friend) => {
            const status = friend.status === 'accepted' ? t('Added') : friend.status === 'declined' ? t('Declined') : friend.recipientId === social?.userId ? t('Awaiting acceptance') : t('Request sent')
            const incoming = friend.status === 'pending' && friend.recipientId === social?.userId
            return <button key={friend.id} className={`contact-row friend-contact-row ${(selected?.kind === 'friend' || selected?.kind === 'friend-chat') && selected.id === friend.person.id ? 'active' : ''}`} onClick={() => onSelect({ kind: 'friend', id: friend.person.id })}><UserAvatar src={friend.person.image || ''} name={friend.person.name} size={34} /><span className="contact-row-copy"><span className="friend-contact-title"><strong>{friend.person.name}</strong><small className={`friend-contact-status ${incoming ? 'pending' : ''}`}>{status}</small></span>{friend.status === 'accepted' && friend.person.email && <small>{friend.person.email}</small>}</span></button>
          })}
          {socialError && <p className="empty-search" role="status">{socialError}</p>}
          {!friends.length && !socialError && <p className="empty-search">{query.trim() ? t('No matching friends') : t('No friends yet')}</p>}

        </div>}
      </div>
      <OverlayScrollbar target={listRef} />
    </aside>
  )
}
