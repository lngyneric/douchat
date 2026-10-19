import { LifeBuoy, X } from 'lucide-react'
import { useEffect, useState, type ReactElement } from 'react'
import { SUPPORT_SHARE_HOURS, type SupportShare } from '../../../shared/cloudSync'
import type { Conversation } from '../../../shared/types'
import { t } from '../preferences'
import { NativeDialog } from './NativeDialog'

const DURATION_LABELS: Record<(typeof SUPPORT_SHARE_HOURS)[number], string> = { 24: '24 hours', 72: '3 days', 168: '7 days' }

/**
 * Lets the user grant Douchat support read access to this one conversation.
 * Access ends at expiry or on revoke, and every read support makes is counted here.
 */
export function SupportShareDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }): ReactElement {
  const [shares, setShares] = useState<SupportShare[]>()
  const [hours, setHours] = useState<(typeof SUPPORT_SHARE_HOURS)[number]>(72)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    window.douchat.supportShares(conversation.id)
      .then((items) => { if (!cancelled) setShares(items) })
      .catch(() => { if (!cancelled) { setShares([]); setError(t('Could not load support access')) } })
    return () => { cancelled = true }
  }, [conversation.id])

  async function run(action: () => Promise<void>, failure: string): Promise<void> {
    setBusy(true); setError('')
    try { await action() } catch { setError(t(failure)) } finally { setBusy(false) }
  }
  const share = () => run(async () => {
    const created = await window.douchat.createSupportShare(conversation.id, hours, note.trim())
    setShares((items) => [created, ...(items ?? [])])
    setNote('')
  }, 'Could not share with support')
  const revoke = (id: string) => run(async () => {
    await window.douchat.revokeSupportShare(id)
    setShares((items) => items?.map((item) => item.id === id ? { ...item, status: 'revoked' } : item))
  }, 'Could not revoke access')

  const statusLabel: Record<SupportShare['status'], string> = { active: t('Access active'), expired: t('Expired'), revoked: t('Revoked') }
  return <NativeDialog className="modal-backdrop conversation-records-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()} onClose={onClose} width={560} height={620}>
    <section className="conversation-records-modal support-share-modal" role="dialog" aria-modal="true" aria-labelledby="support-share-title">
      <header className="records-header">
        <div className="records-title-spacer" />
        <div><h1 id="support-share-title">{t('Share with support')}</h1></div>
        <button type="button" aria-label={t('Close')} title={t('Close')} onClick={onClose}><X size={18} /></button>
      </header>
      <div className="support-share-form">
        <p>{t('Douchat support will be able to read this conversation, including its messages and member names, until access expires or you revoke it. Each time they open it is counted below.')}</p>
        <textarea value={note} maxLength={500} rows={3} placeholder={t('Describe the problem (optional)')} aria-label={t('Describe the problem (optional)')} onChange={(event) => setNote(event.target.value)} />
        <div className="support-share-actions">
          <div role="radiogroup" aria-label={t('Access duration')}>
            {SUPPORT_SHARE_HOURS.map((value) => <button key={value} type="button" role="radio" aria-checked={hours === value} className={hours === value ? 'selected' : ''} onClick={() => setHours(value)}>{t(DURATION_LABELS[value])}</button>)}
          </div>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void share()}>{t('Share')}</button>
        </div>
      </div>
      {error && <p className="records-error" role="alert">{error}</p>}
      <div className="records-list routine-records-list" aria-live="polite">
        {shares?.length === 0 && <div className="records-empty"><LifeBuoy size={28} /><strong>{t('Not shared with support')}</strong><p>{t('Support cannot see this conversation.')}</p></div>}
        {shares?.map((item) => <article className="routine-record" key={item.id}>
          <div className="routine-record-mark"><LifeBuoy size={18} /></div>
          <div className="routine-record-copy">
            <header><strong>{item.note || t('Shared with support')}</strong><span data-status={item.status}>{statusLabel[item.status]}</span></header>
            <div>
              <span>{t('Shared {date}').replace('{date}', new Date(item.createdAt).toLocaleString())}</span>
              <span>{t(item.status === 'active' ? 'Expires {date}' : 'Ended {date}').replace('{date}', new Date(item.expiresAt).toLocaleString())}</span>
              <span>{item.views ? t('Viewed {count} times, last {date}').replace('{count}', String(item.views)).replace('{date}', new Date(item.lastViewedAt!).toLocaleString()) : t('Not viewed yet')}</span>
            </div>
          </div>
          {item.status === 'active' && <div className="routine-record-actions"><button type="button" className="danger support-share-revoke" disabled={busy} onClick={() => void revoke(item.id)}>{t('Revoke')}</button></div>}
        </article>)}
      </div>
    </section>
  </NativeDialog>
}
