import { useEffect, useState } from 'react'
import { Bell, Download, Heart, MessagesSquare, Pencil, Plus, RefreshCcw, Trash2, Upload, X } from 'lucide-react'
import { useUI } from '../../stores/ui'
import { usePlayback } from '../../stores/playback'
import { usePlaylist } from '../../stores/playlist'
import { useIngest } from '../../stores/ingest'
import { ipc } from '../../lib/ipc'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useToast } from '../../stores/toast'
import { useUpdater } from '../../stores/updater'
import { useReminders } from '../../stores/reminders'
import { openCommunityLink, openSupportLink, useAppInfo } from '../../stores/appInfo'
import { languageName, useTvPrefs } from '../../stores/tvPrefs'
import { UP_NEXT_SECONDS } from '../../stores/upNext'
import { daysLeft, expiryLabel, useAccounts } from '../../stores/accounts'
import { ParentalSection } from './ParentalSection'
import { cn } from '../../lib/cn'
import { hhmm, weekday } from '../../lib/time'
import { describeRestore, restoreBackup, saveBackup } from '../../lib/backup'

export function SettingsPanel() {
  const { settingsOpen, toggleSettings, openAddSource } = useUI()
  const { sources, hydrate } = usePlaylist()
  const { push } = useToast()

  // Fresh subscription details each time Settings opens.
  useEffect(() => {
    if (settingsOpen) useAccounts.getState().loadAll(sources).catch(() => {})
  }, [settingsOpen, sources])

  if (!settingsOpen) return null

  const refresh = async (id: number, name: string) => {
    // Flip the ingest overlay up immediately — the first `fetching` event
    // from Rust can take a second on slow links, and we want the UI locked
    // the moment the click happens.
    useIngest.getState().begin(id, name)
    try {
      await ipc.refreshSource(id)
      push('success', `Refreshed ${name}`)
      await hydrate()
    } catch (e) {
      push('error', String(e))
    } finally {
      // If Rust threw before emitting `done`, we still need to clear the
      // overlay ourselves.
      useIngest.getState().end()
    }
  }

  const remove = async (id: number) => {
    try {
      const pb = usePlayback.getState()
      if (pb.channel?.sourceId === id) pb.stop()
      await ipc.removeSource(id)
      await hydrate()
    } catch (e) {
      push('error', String(e))
    }
  }

  return (
    <div className="fixed inset-0 z-40 grid place-items-end bg-black/50 animate-fade-in" onClick={toggleSettings}>
      <aside
        className="flex h-full min-h-0 w-96 flex-col border-l border-neutral-800 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">Settings</h2>
          <button
            onClick={toggleSettings}
            className="grid h-6 w-6 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Everything below the title scrolls as one: the sections are
            taller than many screens. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              Playlists
            </span>
            <button
              onClick={openAddSource}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-accent-400 px-2.5 text-xs font-semibold text-neutral-950 hover:bg-accent-300"
            >
              <Plus className="h-3 w-3" />
              Add
            </button>
          </div>

          {sources.length === 0 && (
            <div className="rounded-md border border-dashed border-neutral-800 p-6 text-center text-xs text-neutral-500">
              No playlists yet. Add one to get started.
            </div>
          )}

          <ul className="space-y-1.5">
            {sources.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <SourceName id={s.id} name={s.name} onRenamed={() => hydrate().catch(() => {})} />
                  <div className="truncate text-[11px] text-neutral-500">
                    {s.kind.toUpperCase()} · {new URL(s.url.startsWith('http') ? s.url : 'file://' + s.url).hostname || s.url}
                  </div>
                  <AccountLine sourceId={s.id} />
                </div>
                <button
                  onClick={() => refresh(s.id, s.name)}
                  className="grid h-7 w-7 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  aria-label="Refresh"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => remove(s.id)}
                  className="grid h-7 w-7 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                  aria-label="Remove"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>

        <ParentalSection />
        <PlaybackSection />
        <GuideSection />
        <RemindersSection />
        <BackupSection />
        <AboutSection />
        </div>
      </aside>
    </div>
  )
}

/** A new GitHub issue with a short template (no personal data in the URL). */
const REPORT_BODY = [
  '**What happened?**',
  '',
  '',
  '**What did you expect?**',
  '',
  '',
  '**Steps to get there**',
  '1. ',
  '',
  `**Tenvy version:** ${__APP_VERSION__}`,
  '',
  '**Diagnostics** (Settings → About → Copy diagnostics, then paste here):',
  '```',
  '',
  '```',
].join('\n')
const REPORT_URL =
  'https://github.com/quph4/tenvy-releases/issues/new?title=' +
  encodeURIComponent('Problem: ') +
  '&body=' +
  encodeURIComponent(REPORT_BODY)

function AboutSection() {
  const push = useToast((s) => s.push)
  const status = useUpdater((s) => s.status)
  const checkForUpdates = useUpdater((s) => s.checkForUpdates)
  const install = useUpdater((s) => s.install)
  const support = useAppInfo((s) => s.info?.config.support ?? null)
  const community = useAppInfo((s) => s.info?.config.community ?? null)

  const line =
    status.kind === 'checking'
      ? 'Checking for updates…'
      : status.kind === 'none'
        ? "You're on the latest version."
        : status.kind === 'available'
          ? `Version ${status.version} is available.`
          : status.kind === 'downloading'
            ? `Downloading ${status.version}…`
            : status.kind === 'error'
              ? `Couldn't check for updates: ${status.message}`
              : status.kind === 'store'
                ? 'Updates come from the Microsoft Store.'
                : null

  return (
    <div className="border-t border-neutral-800 p-5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">About</span>
      <div className="mt-2 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-neutral-200">Tenvy {__APP_VERSION__}</div>
          {line && <div className="mt-0.5 text-[11px] text-neutral-500">{line}</div>}
        </div>
        {status.kind === 'available' ? (
          <button
            onClick={() => install()}
            className="inline-flex h-7 items-center rounded-md bg-accent-400 px-2.5 text-xs font-semibold text-neutral-950 hover:bg-accent-300"
          >
            Install
          </button>
        ) : status.kind === 'store' ? null : (
          <button
            onClick={() => checkForUpdates(true)}
            disabled={status.kind === 'checking' || status.kind === 'downloading'}
            className="inline-flex h-7 items-center rounded-md border border-neutral-800 px-2.5 text-xs text-neutral-300 hover:border-neutral-700 disabled:opacity-50"
          >
            Check for updates
          </button>
        )}
      </div>
      {community && (
        <button
          onClick={openCommunityLink}
          className="mt-3 flex w-full items-center gap-3 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2.5 text-left hover:border-neutral-700"
        >
          <MessagesSquare className="h-4 w-4 shrink-0 text-accent-400" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-neutral-200">{community.label ?? 'Join the community'}</span>
            <span className="block text-[11px] text-neutral-500">Questions, ideas or something not working? Ask there — news about updates, too.</span>
          </span>
        </button>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={() => openUrl(REPORT_URL).catch(() => {})}
          className="inline-flex h-7 items-center rounded-md border border-neutral-800 px-2.5 text-xs text-neutral-300 hover:border-neutral-700"
        >
          Report a problem
        </button>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(await ipc.diagnostics())
              push('success', 'Diagnostics copied — paste them into your report.')
            } catch (e) {
              push('error', `Couldn't copy diagnostics: ${String(e).replace(/^Error:\s*/, '')}`)
            }
          }}
          className="inline-flex h-7 items-center rounded-md border border-neutral-800 px-2.5 text-xs text-neutral-300 hover:border-neutral-700"
          title="Version, library counts and the end of the log — logins and addresses removed"
        >
          Copy diagnostics
        </button>
      </div>
      <div className="mt-3 flex gap-4 text-[11px]">
        <button onClick={() => ipc.openLicenses().catch(() => {})} className="text-neutral-500 hover:text-neutral-300">
          Open-source licenses
        </button>
        <button
          onClick={() => openUrl('https://quph4.github.io/tenvy-releases/privacy.html').catch(() => {})}
          className="text-neutral-500 hover:text-neutral-300"
        >
          Privacy
        </button>
      </div>
      {support && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-accent-500/20 bg-accent-400/5 px-3 py-2.5">
          <Heart className="h-4 w-4 shrink-0 text-accent-400" />
          <div className="min-w-0 flex-1 text-xs leading-relaxed text-neutral-400">
            Tenvy is free. If you enjoy it, you can support its development.
          </div>
          <button
            onClick={openSupportLink}
            className="inline-flex h-7 shrink-0 items-center rounded-md bg-accent-400 px-2.5 text-xs font-semibold text-neutral-950 hover:bg-accent-300"
          >
            {support.label ?? 'Support Tenvy'}
          </button>
        </div>
      )}
    </div>
  )
}

/** A provider's name; click (or the pencil) to rename it in place. */
function SourceName({ id, name, onRenamed }: { id: number; name: string; onRenamed(): void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const push = useToast((s) => s.push)

  const save = async () => {
    const next = value.trim()
    setEditing(false)
    if (!next || next === name) return setValue(name)
    try {
      await ipc.renameSource(id, next)
      onRenamed()
    } catch (e) {
      setValue(name)
      push('error', String(e).replace(/^Error:\s*/, ''))
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        maxLength={60}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') {
            e.stopPropagation()
            setValue(name)
            setEditing(false)
          }
        }}
        onFocus={(e) => e.target.select()}
        className="-mx-1 h-6 w-full rounded border border-accent-400 bg-neutral-950 px-1 text-sm text-neutral-100 outline-none"
      />
    )
  }
  return (
    <button
      onClick={() => {
        setValue(name)
        setEditing(true)
      }}
      title="Rename"
      className="group/name flex max-w-full items-center gap-1.5 text-left text-neutral-200 hover:text-white"
    >
      <span className="truncate">{name}</span>
      <Pencil className="h-3 w-3 shrink-0 text-neutral-600 opacity-0 transition-opacity group-hover/name:opacity-100" />
    </button>
  )
}

/** Subscription status, expiry and connections for an Xtream source. */
function AccountLine({ sourceId }: { sourceId: number }) {
  const info = useAccounts((s) => s.bySource[sourceId])
  if (!info) return null
  const left = daysLeft(info)
  const warn = left != null && left <= 14
  const conns =
    info.maxConnections != null ? `${info.activeConnections ?? 0}/${info.maxConnections} connections` : null
  return (
    <div className={cn('truncate text-[11px]', warn ? 'text-amber-300' : 'text-neutral-500')}>
      {[info.status, info.isTrial ? 'Trial' : null, expiryLabel(info), conns].filter(Boolean).join(' · ')}
    </div>
  )
}

function PlaybackSection() {
  const { tracks, startWithLastChannel, setStartWithLastChannel, resetTracks, dailyRefresh, setDailyRefresh, autoNext, setAutoNext } =
    useTvPrefs()
  const audio = languageName(tracks.audioLang)
  const subs = tracks.subsOff ? 'Off' : languageName(tracks.subLang)
  return (
    <div className="border-t border-neutral-800 p-5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Playback</span>
      <label className="mt-3 flex cursor-pointer items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-neutral-200">Start with the last channel</span>
          <span className="block text-[11px] text-neutral-500">Tune in to what you watched last when Tenvy opens.</span>
        </span>
        <input
          type="checkbox"
          checked={startWithLastChannel}
          onChange={(e) => setStartWithLastChannel(e.target.checked)}
          className="h-4 w-4 accent-[#D4B47C]"
        />
      </label>
      <label className="mt-4 flex cursor-pointer items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-neutral-200">Play the next episode automatically</span>
          <span className="block text-[11px] text-neutral-500">When an episode ends, the next one starts after {UP_NEXT_SECONDS} seconds.</span>
        </span>
        <input
          type="checkbox"
          checked={autoNext}
          onChange={(e) => setAutoNext(e.target.checked)}
          className="h-4 w-4 accent-[#D4B47C]"
        />
      </label>
      <label className="mt-4 flex cursor-pointer items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-neutral-200">Update playlists daily</span>
          <span className="block text-[11px] text-neutral-500">New channels, films and the guide arrive by themselves, in the background.</span>
        </span>
        <input
          type="checkbox"
          checked={dailyRefresh}
          onChange={(e) => setDailyRefresh(e.target.checked)}
          className="h-4 w-4 accent-[#D4B47C]"
        />
      </label>
      <div className="mt-4 flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-neutral-200">Languages</div>
          <div className="text-[11px] text-neutral-500">
            {audio || subs
              ? `Audio: ${audio ?? 'automatic'} · Subtitles: ${subs ?? 'automatic'} — from your last choice.`
              : 'Pick an audio or subtitle language once and Tenvy uses it everywhere.'}
          </div>
        </div>
        {(audio || subs) && (
          <button
            onClick={resetTracks}
            className="inline-flex h-7 shrink-0 items-center rounded-md border border-neutral-800 px-2.5 text-xs text-neutral-300 hover:border-neutral-700"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  )
}

/** −6 h … +6 h in half hours. */
const OFFSETS = Array.from({ length: 25 }, (_, i) => (i - 12) * 30)

function offsetLabel(m: number): string {
  if (m === 0) return 'As the provider sends it'
  const h = Math.floor(Math.abs(m) / 60)
  const rest = Math.abs(m) % 60
  const amount = [h ? `${h} h` : '', rest ? `${rest} min` : ''].filter(Boolean).join(' ')
  return `${amount} ${m > 0 ? 'later' : 'earlier'}`
}

function GuideSection() {
  const [offset, setOffset] = useState<number | null>(null)
  const push = useToast((s) => s.push)
  useEffect(() => {
    ipc.epgOffset().then(setOffset).catch(() => setOffset(0))
  }, [])
  const change = async (minutes: number) => {
    const before = offset
    setOffset(minutes)
    try {
      await ipc.setEpgOffset(minutes)
      useReminders.getState().load().catch(() => {})
    } catch (e) {
      setOffset(before)
      push('error', `Couldn't change the guide time: ${e}`)
    }
  }
  return (
    <div className="border-t border-neutral-800 p-5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Guide</span>
      <label className="mt-3 flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-neutral-200">Guide times</span>
          <span className="block text-[11px] text-neutral-500">If programmes start earlier or later than the guide says, move the guide to match.</span>
        </span>
        <select
          aria-label="Guide time adjustment"
          value={offset ?? 0}
          disabled={offset == null}
          onChange={(e) => change(Number(e.target.value))}
          className="h-8 shrink-0 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-200 outline-none focus:border-accent-400/60"
        >
          {OFFSETS.map((m) => (
            <option key={m} value={m}>
              {offsetLabel(m)}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/** Save everything to a file, or bring it back (e.g. on a new PC). */
function BackupSection() {
  const [busy, setBusy] = useState<null | 'save' | 'restore'>(null)
  const [note, setNote] = useState<{ text: string; error?: boolean; details?: string[] } | null>(null)

  const save = async () => {
    setBusy('save')
    setNote(null)
    try {
      const path = await saveBackup()
      if (path) setNote({ text: `Saved to ${path}` })
    } catch (e) {
      setNote({ text: `Couldn't save the backup: ${String(e).replace(/^Error:\s*/, '')}`, error: true })
    } finally {
      setBusy(null)
    }
  }
  const restore = async () => {
    setBusy('restore')
    setNote(null)
    try {
      const report = await restoreBackup()
      if (report) {
        setNote({
          text: describeRestore(report),
          error: report.sourcesFailed.length > 0,
          details: report.sourcesFailed.map((f) => `Couldn't add ${f}`),
        })
      }
    } catch (e) {
      setNote({ text: String(e).replace(/^Error:\s*/, ''), error: true })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="border-t border-neutral-800 p-5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Backup</span>
      <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
        Providers, favorites, hidden channels and categories, what you've watched, the parental lock and your settings — in one
        file, to move Tenvy to another PC. Keep the file to yourself: it holds your provider logins.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={save}
          disabled={busy !== null}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-800 px-3 text-xs text-neutral-200 hover:border-neutral-700 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          {busy === 'save' ? 'Saving…' : 'Save a backup…'}
        </button>
        <button
          onClick={restore}
          disabled={busy !== null}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-neutral-800 px-3 text-xs text-neutral-200 hover:border-neutral-700 disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" />
          {busy === 'restore' ? 'Restoring…' : 'Restore from a backup…'}
        </button>
      </div>
      {note && (
        <div role="status" className={cn('mt-2 text-[11px] leading-relaxed', note.error ? 'text-amber-300' : 'text-neutral-400')}>
          <p className="break-all">{note.text}</p>
          {note.details?.map((d) => (
            <p key={d}>{d}</p>
          ))}
        </div>
      )}
    </div>
  )
}

function RemindersSection() {
  const items = useReminders((s) => s.items)
  const remove = useReminders((s) => s.remove)
  if (items.length === 0) return null
  return (
    <div className="border-t border-neutral-800 p-5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">Reminders</span>
      <ul className="mt-2 space-y-1.5">
        {items.map((r) => (
          <li
            key={`${r.channel.id}:${r.start}`}
            className="flex items-center gap-2 rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-sm"
          >
            <Bell className="h-3.5 w-3.5 shrink-0 text-accent-400" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-neutral-200">{r.title}</div>
              <div className="truncate text-[11px] text-neutral-500">
                {weekday(r.start)} {hhmm(r.start)} · {r.channel.name}
              </div>
            </div>
            <button
              onClick={() => remove(r.channel.id, r.start).catch(() => {})}
              className="grid h-7 w-7 place-items-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
              aria-label="Remove reminder"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
