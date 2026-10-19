import type { CreateRoutineInput, Routine, RoutineSchedule } from '../shared/types'
import { isDouchatCreditError } from '../shared/bot/errors'
import type { DouchatRuntime } from './runtime'
import { DouchatStore } from './store'

const MAX_TIMER_DELAY = 60_000
const ONE_TIME_RETRY_DELAY = 60_000
const ONE_TIME_MAX_ATTEMPTS = 2

export function nextRoutineOccurrence(schedule: RoutineSchedule, after: number): number {
  if (schedule.kind === 'once') return schedule.runAt
  if (schedule.kind === 'interval') {
    const minutes = Math.max(1, Math.round(schedule.intervalMinutes))
    return after + minutes * 60_000
  }

  const days = new Set(schedule.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))
  const [rawHour, rawMinute] = schedule.time.split(':').map(Number)
  const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, rawHour)) : 9
  const minute = Number.isFinite(rawMinute) ? Math.min(59, Math.max(0, rawMinute)) : 0

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(after)
    candidate.setSeconds(0, 0)
    candidate.setDate(candidate.getDate() + offset)
    candidate.setHours(hour, minute, 0, 0)
    if (days.has(candidate.getDay()) && candidate.getTime() > after) return candidate.getTime()
  }

  return after + 24 * 60 * 60_000
}

export class RoutineScheduler {
  private timer?: NodeJS.Timeout
  private disposed = false
  private readonly oneTimeAttempts = new Map<string, number>()

  constructor(
    private readonly store: DouchatStore,
    private readonly runtime: DouchatRuntime,
    private readonly onChange: () => void,
    private readonly getDouchatCredits?: () => Promise<number>
  ) {}

  start(): void {
    this.scheduleNextTick()
  }

  /** Authentication can switch while the desktop process stays alive. Drop
   * per-account retry bookkeeping and immediately rebuild the timer from the
   * newly active account's routines. */
  accountChanged(): void {
    this.oneTimeAttempts.clear()
    this.scheduleNextTick()
  }

  createRoutine(input: CreateRoutineInput): Routine {
    const routine = this.store.createRoutine(input, nextRoutineOccurrence(input.schedule, Date.now()))
    this.onChange()
    this.scheduleNextTick()
    return routine
  }

  deleteRoutine(routineId: string): void {
    if (!this.store.accountRoutines.some((routine) => routine.id === routineId)) {
      throw new Error('Routine not found')
    }
    this.store.deleteRoutine(routineId)
    this.onChange()
    this.scheduleNextTick()
  }

  setEnabled(routineId: string, enabled: boolean): void {
    const routine = this.store.accountRoutines.find((item) => item.id === routineId)
    if (!routine) throw new Error('Routine not found')
    if (enabled && routine.schedule.kind === 'once' && routine.schedule.runAt <= Date.now()) {
      throw new Error('One-time routine has already passed')
    }
    const nextRunAt = enabled ? nextRoutineOccurrence(routine.schedule, Date.now()) : routine.nextRunAt
    this.store.setRoutineEnabled(routineId, enabled, nextRunAt)
    this.onChange()
    this.scheduleNextTick()
  }

  async runNow(routineId: string): Promise<void> {
    const routine = this.store.accountRoutines.find((item) => item.id === routineId)
    if (!routine) throw new Error('Routine not found')
    await this.runtime.runRoutine(routine, 'manual')
  }

  checkNow(): void {
    void this.runDueRoutines()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
  }

  private scheduleNextTick(): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    const earliest = this.store.accountRoutines
      .filter((routine) => routine.enabled)
      .reduce((next, routine) => Math.min(next, routine.nextRunAt), Number.POSITIVE_INFINITY)
    const delay = Number.isFinite(earliest)
      ? Math.min(MAX_TIMER_DELAY, Math.max(250, earliest - Date.now()))
      : MAX_TIMER_DELAY
    this.timer = setTimeout(() => void this.runDueRoutines(), delay)
  }

  /** A confirmed zero balance is different from a temporary usage-service
   * failure. Only the former blocks first-party cloud agents; local agents can
   * keep running without Douchat credits. */
  private async creditBlockedRoutineIds(routines: Routine[]): Promise<Set<string>> {
    if (!this.getDouchatCredits) return new Set()
    const cloud = routines.filter((routine) => !this.store.agent(routine.agentId)?.localAgentId)
    if (!cloud.length) return new Set()
    try {
      const credits = await this.getDouchatCredits()
      return credits <= 0 ? new Set(cloud.map((routine) => routine.id)) : new Set()
    } catch {
      // Do not turn a temporary balance-service outage into a skipped task.
      // The model request remains the source of truth and its error handling
      // will pause the routine if the gateway confirms the balance is empty.
      return new Set()
    }
  }

  private pauseBeforeCreditlessRun(routine: Routine): void {
    this.store.setRoutineEnabled(routine.id, false, routine.nextRunAt)
    const conversation = this.store.conversation(routine.conversationId)
    if (!conversation) return
    this.store.addMessage({
      conversationId: conversation.id,
      topicId: this.store.activeTopicId(conversation.id),
      authorId: 'system',
      authorName: 'Douchat',
      text: 'Douchat credit balance is insufficient',
      kind: 'system'
    })
    this.store.addUnread(conversation.id, 1)
  }

  private async runDueRoutines(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    // Synced routines from other computers run there, not here.
    const due = this.store.accountRoutines.filter((routine) => routine.enabled && routine.nextRunAt <= now
      && (!routine.deviceId || routine.deviceId === this.store.cloudSync.installId))
    const creditBlocked = await this.creditBlockedRoutineIds(due)
    const runnable = due.filter((routine) => !creditBlocked.has(routine.id))

    for (const routine of due) {
      if (creditBlocked.has(routine.id)) this.pauseBeforeCreditlessRun(routine)
    }

    for (const routine of runnable) {
      const triggeredAt = Date.now()
      this.store.markRoutineTriggered(
        routine.id,
        triggeredAt,
        nextRoutineOccurrence(routine.schedule, triggeredAt)
      )
      if (routine.schedule.kind === 'once') this.store.setRoutineEnabled(routine.id, false, routine.schedule.runAt)
    }
    if (due.length) this.onChange()
    this.scheduleNextTick()

    const previousFailures = new Map(runnable.map((routine) => [
      routine.id,
      this.store.accountRuns.filter((run) => run.routineId === routine.id && run.status === 'failed').length
    ]))
    const outcomes = await Promise.allSettled(runnable.map((routine) => this.runtime.runRoutine(routine, 'schedule')))
    let retryScheduled = false
    outcomes.forEach((outcome, index) => {
      const routine = runnable[index]
      if (outcome.status === 'rejected' && isDouchatCreditError(outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason))) {
        this.store.setRoutineEnabled(routine.id, false, routine.nextRunAt)
        this.oneTimeAttempts.delete(routine.id)
        retryScheduled = true
        return
      }
      if (routine.schedule.kind !== 'once') return
      if (outcome.status === 'fulfilled') {
        this.oneTimeAttempts.delete(routine.id)
        return
      }
      const attempts = Math.max(
        (previousFailures.get(routine.id) ?? 0) + 1,
        (this.oneTimeAttempts.get(routine.id) ?? 0) + 1
      )
      this.oneTimeAttempts.set(routine.id, attempts)
      if (attempts < ONE_TIME_MAX_ATTEMPTS) {
        this.store.setRoutineEnabled(routine.id, true, Date.now() + ONE_TIME_RETRY_DELAY)
        retryScheduled = true
      }
    })
    if (retryScheduled) this.onChange()
    this.scheduleNextTick()
  }
}
