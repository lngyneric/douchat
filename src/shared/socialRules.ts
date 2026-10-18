import { addressesEveryone, resolveMentionedMembers, type SelectedMention } from './bot/mentions'
import type { SocialAgent, SocialSnapshot } from './social'

/** Friend and shared-group rules every client applies the same way. */

/**
 * Keep private contact data out of renderer state unless the signed-in user is
 * allowed to see it. The service remains the primary privacy boundary; this is
 * a second boundary for older service responses and cached room membership.
 */
export function privacySafeSocialSnapshot(snapshot: SocialSnapshot): SocialSnapshot {
  const emailVisibleTo = new Set([
    snapshot.userId,
    ...snapshot.friendships.filter((friendship) => friendship.status === 'accepted').map((friendship) => friendship.person.id)
  ])
  const protectPerson = (person: SocialSnapshot['rooms'][number]['members'][number]) =>
    emailVisibleTo.has(person.id) || !person.email ? person : { ...person, email: '' }

  return {
    ...snapshot,
    friendships: snapshot.friendships.map((friendship) => ({ ...friendship, person: protectPerson(friendship.person) })),
    rooms: snapshot.rooms.map((room) => ({ ...room, members: room.members.map(protectPerson) }))
  }
}

export function sharedGroupReplyTargets(content: string, agents: SocialAgent[], humans: { id: string; name: string }[] = [], requesterId?: string, selections?: SelectedMention[]): string[] {
  if (addressesEveryone(content)) {
    if (!requesterId || humans[0]?.id !== requesterId) throw new Error('Only the group owner can mention everyone.')
    return agents.filter(agent => agent.ownerId === requesterId || agent.interactionHumans === 'allow' || agent.interactionHumans === 'ask').map(agent => agent.id)
  }
  // Explicit mentions take priority over any eligible follow-up recipient.
  const members = [...humans, ...agents]
  const addressed = resolveMentionedMembers(content, members, selections)
  return addressed.filter(member => agents.some(agent => agent.id === member.id)).map(member => member.id)
}

/** Agent rooms are a transport for daemon agents, not chats the social UI lists. */
export function rendererSocialSnapshot(snapshot: SocialSnapshot): SocialSnapshot {
  return snapshot.rooms.some(room => room.kind === 'agent') ? { ...snapshot, rooms: snapshot.rooms.filter(room => room.kind !== 'agent') } : snapshot
}

export function checkHumanAgentTargets(ids: string[], agents: SocialAgent[], requesterId: string): void {
  for (const id of ids) {
    const agent = agents.find(member => member.id === id)
    if (!agent) throw new Error('The selected agent is no longer a member of this group.')
    if (agent.ownerId === requesterId) continue
    if (agent.interactionHumans === 'deny') throw new Error(`The owner of "${agent.name}" has disabled requests from group members.`)
    if (!agent.interactionHumans) throw new Error(`Permissions for "${agent.name}" have not synchronized. Ask the owner to reconnect.`)
    // `ask` is not consent: the executing owner's runtime still requests approval.
  }
}

