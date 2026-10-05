import { useEffect, useRef } from 'react'
import type { Channel } from '../../types'
import { usePlayback } from '../../stores/playback'
import { ipc, onMpvEvent, onMpvState, subscribe } from '../../lib/ipc'
import { useToast } from '../../stores/toast'
import { END_GUARD, useHistory } from '../../stores/history'
import { rememberLastChannel, useTvPrefs } from '../../stores/tvPrefs'
import { osd, showChannelInfo } from '../../lib/osd'
import { usePlaylist } from '../../stores/playlist'
import { daysLeft, useAccounts } from '../../stores/accounts'
import { applyAspect, savedAspect } from '../../lib/picture'
// Next-episode countdown: it follows the playback store from here on.
import '../../stores/upNext'

/*
 * Playback that doesn't depend on the player being on screen: opening what
 * the store says should play, reconnecting, volume and mute, saving film
 * progress, and recovering from an mpv crash. It lives in PlaybackHost,
 * mounted once by App — the Player component only draws the video rect and
 * the controls. (When these lived in the Player, they stopped whenever you
 * went to Home, the guide or the library while something kept playing.)
 */

/** Wait before retrying a stream that failed to open. */
const RETRY_DELAY_MS = 2000
/** No progress this long while playing means the stream stalled. */
const STALL_MS = 15_000
/** Waits before each reconnect in a row; then we give up and ask. */
const BACKOFF_MS = [1000, 3000, 6000, 10_000, 15_000]
/** Trouble-free playback this long resets the reconnect count. */
const STABLE_MS = 60_000
/** A live channel on screen this long counts as watched. */
const LIVE_WATCHED_MS = 10_000

/**
 * Open whatever the playback store says should be playing: the live
 * channel, its catch-up programme, or a VOD at its resume point.
 *
 * `resume` reopens the current pick (retry after a failure, recovery after
 * a crash) at the last known position instead of consuming the one-shot
 * `pendingStart` from the Resume prompt.
 */
function openCurrent(
  push: (kind: 'error' | 'info', message: string) => void,
  resume: boolean,
  /** Where to pick up when reopening (the keeper's last good position);
   *  mpv's own position is gone once the stream has dropped. */
  resumeAt: number | null = null,
) {
  const pb = usePlayback.getState()
  const channel = pb.channel
  if (!channel) return
  const vod = channel.kind === 'movie' || channel.kind === 'series'
  let start: number | null
  if (resume) {
    // Films and catch-up continue where they were; live joins live.
    start = vod || pb.catchup ? (resumeAt ?? pb.timePos) : null
  } else {
    start = pb.pendingStart
    pb.consumePendingStart()
  }
  const prefs = useTvPrefs.getState().tracks
  const catchup = pb.catchup
  const nonce = pb.playNonce
  const stillOn = () => usePlayback.getState().playNonce === nonce
  const open = catchup
    ? ipc.mpvLoadCatchup(channel.id, catchup.start, catchup.stop, prefs, start)
    : ipc.mpvLoad(channel.id, start, prefs)
  open
    .then((gen) => {
      if (stillOn()) usePlayback.setState({ loadGen: gen })
    })
    // mpv's pause flag survives loadfile — a new channel picked while the
    // previous one was paused should still start playing.
    .then(() => (stillOn() ? ipc.mpvSetPause(false) : undefined))
    .then(() => {
      if (!stillOn()) return // zapped on while this was opening
      const aspect = savedAspect()
      if (aspect !== 'auto') applyAspect(aspect)
      if (channel.kind !== 'live' || catchup || resume) return
      rememberLastChannel(channel)
      showChannelInfo(channel).catch(() => {})
      // Count it as watched once it's stayed on for a bit (zapping past a
      // channel doesn't), for History and "Recently watched" on Home.
      window.setTimeout(() => {
        if (usePlayback.getState().channel?.id === channel.id) {
          useHistory.getState().record(channel.id, 0, 0, false).catch(() => {})
        }
      }, LIVE_WATCHED_MS)
    })
    .catch((e) => {
      if (!stillOn()) return
      // Surface the real failure — unreachable URL, auth rejection, no
      // catch-up for that time. Without this toast the user clicks a
      // channel and sees nothing happen, which is the worst kind of bug.
      push('error', `Playback failed: ${String(e).replace(/^Error:\s*/, '')}`)
    })
}

/**
 * Keeps the stream going. A pick that fails to open gets one retry, then
 * an explanation. Once something has played, a dropped connection (the
 * stream ends early, errors, or stops moving for STALL_MS) is reopened
 * with growing pauses — at the same position for films — and after
 * BACKOFF_MS.length tries in a row we stop and offer "Try again".
 */
function useConnectionKeeper(push: ReturnType<typeof useToast.getState>['push']) {
  useEffect(() => {
    let nonce = -1
    let played = false // this pick has shown progress at least once
    let openRetried = false
    let attempts = 0
    let gaveUp = false
    let recovering = false // a reconnect is under way or awaiting progress
    let lastPos: number | null = null
    let lastProgress = Date.now()
    let lastReconnect = 0
    let timer: number | undefined

    const reset = (n: number) => {
      window.clearTimeout(timer)
      timer = undefined
      nonce = n
      played = openRetried = gaveUp = recovering = false
      attempts = 0
      lastPos = null
      lastProgress = Date.now()
    }

    const reopenAfter = (ms: number) => {
      const n = nonce
      lastProgress = Date.now() + ms
      timer = window.setTimeout(() => {
        timer = undefined
        if (usePlayback.getState().playNonce !== n) return
        lastProgress = Date.now()
        openCurrent(push, true, lastPos)
      }, ms)
    }

    const reconnect = () => {
      const ch = usePlayback.getState().channel
      if (!ch || timer !== undefined) return
      if (attempts >= BACKOFF_MS.length) {
        gaveUp = true
        osd(`Lost the connection to ${ch.name}`, 5000)
        push('error', `Lost the connection to ${ch.name}. Check your internet, or try again in a moment.`, {
          action: {
            label: 'Try again',
            run: () => {
              attempts = 0
              gaveUp = false
              lastProgress = Date.now()
              openCurrent(push, true, lastPos)
            },
          },
        })
        return
      }
      const wait = BACKOFF_MS[attempts++]
      lastReconnect = Date.now()
      recovering = true
      const of = `${attempts}/${BACKOFF_MS.length}`
      osd(attempts === 1 ? `Connection lost — reconnecting (${of})…` : `Reconnecting (${of})…`, wait + 4000)
      reopenAfter(wait)
    }

    const failedToOpen = () => {
      const s = usePlayback.getState()
      if (!s.channel || timer !== undefined) return
      if (played) return reconnect()
      if (!openRetried) {
        openRetried = true
        return reopenAfter(RETRY_DELAY_MS)
      }
      // Said once; the watchdog stays quiet until the next pick.
      gaveUp = true
      if (s.catchup) {
        // Seen in practice: channels flagged as archived whose recordings
        // the panel answers with an empty page.
        push('error', `Your provider has no recording of "${s.catchup.title}" on ${s.channel.name}.`)
      } else {
        explainOpenFailure(s.channel, s.lastError).then((msg) => push('error', msg))
      }
    }

    const tick = () => {
      const pb = usePlayback.getState()
      if (pb.playNonce !== nonce) reset(pb.playNonce)
      if (!pb.channel || pb.pendingResume || gaveUp) return
      const now = Date.now()

      if (pb.timePos != null && pb.timePos !== lastPos) {
        if (lastPos != null) {
          if (recovering) osd('Reconnected', 1500)
          recovering = false
          played = true
          if (attempts > 0 && now - lastReconnect > STABLE_MS) attempts = 0
        }
        lastPos = pb.timePos
        lastProgress = now
      }
      if (timer !== undefined) return

      if (pb.eofReached) {
        const film = pb.channel.kind !== 'live' || pb.catchup
        // Archive streams often carry no duration; the guide knows it.
        const duration = pb.duration ?? (pb.catchup ? pb.catchup.stop - pb.catchup.start : null)
        const atEnd = film && duration != null && pb.timePos != null && pb.timePos >= duration - END_GUARD * 2
        if (played && !atEnd) reconnect()
        return
      }
      if (!pb.playing) {
        // Paused on purpose: nothing to watch for.
        lastProgress = now
        return
      }
      if (now - lastProgress > STALL_MS) {
        if (played) reconnect()
        else failedToOpen()
      }
    }

    const interval = window.setInterval(tick, 1000)
    const unsubscribe = usePlayback.subscribe((s, prev) => {
      if (s.errorSeq === prev.errorSeq || !s.channel) return
      // A fast failure right after a switch belongs to the new pick.
      if (s.playNonce !== nonce) reset(s.playNonce)
      failedToOpen()
    })
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(timer)
      unsubscribe()
    }
  }, [push])
}

/**
 * Why a stream won't open, in words: ask the provider about the account
 * (expired, connections in use) before falling back to the generic hint.
 */
async function explainOpenFailure(channel: Channel, lastError: string | null): Promise<string> {
  const source = usePlaylist.getState().sources.find((s) => s.id === channel.sourceId)
  if (source) {
    await useAccounts.getState().load(source).catch(() => {})
    const info = useAccounts.getState().bySource[source.id]
    const left = daysLeft(info)
    if (info && ((left != null && left < 0) || (info.status && !/^active$/i.test(info.status)))) {
      return `Your ${source.name} subscription is ${left != null && left < 0 ? 'expired' : info.status?.toLowerCase()}. Renew it with your provider to keep watching.`
    }
    if (info?.maxConnections != null && (info.activeConnections ?? 0) >= info.maxConnections) {
      return info.maxConnections === 1
        ? `Your ${source.name} account allows one stream at a time, and another player is using it. Close it and try again.`
        : `All ${info.maxConnections} connections on your ${source.name} account are in use. Close another player and try again.`
    }
  }
  return (
    `Couldn't open ${channel.name}${lastError ? ` (${lastError})` : ''}. ` +
    'If your provider allows one connection at a time, close any other player using it.'
  )
}

/** Mount once (App). Renders nothing. */
export function PlaybackHost() {
  const push = useToast((s) => s.push)
  const channel = usePlayback((s) => s.channel)
  const volume = usePlayback((s) => s.volume)
  const muted = usePlayback((s) => s.muted)

  // 1) Init mpv once on mount. Idempotent on the Rust side so strict-mode
  //    double-invoke is fine. Subscribe to state events regardless of
  //    success — if Rust rejected init, no events will fire.
  useEffect(() => {
    ipc.mpvInit()
      .then(() => usePlayback.setState({ initError: null }))
      .catch((e) => {
        usePlayback.setState({ initError: String(e) })
        push('error', `mpv init failed: ${e}`)
      })
    return subscribe(() => onMpvState((s) => usePlayback.getState().applyMpvState(s)))
  }, [push])

  // 2) Load / reload when the user picks a channel. For VOD we look up a
  //    saved resume position and pass it through as mpv's start time,
  //    which is a single load atom — no extra seek round-trip.
  const channelId = channel?.id
  const playNonce = usePlayback((s) => s.playNonce)
  const catchup = usePlayback((s) => s.catchup)
  const isVod = channel?.kind === 'movie' || channel?.kind === 'series'
  useEffect(() => {
    if (channelId === undefined) {
      ipc.mpvStop().catch(() => {})
      // Also park the native child off-screen. Sending w=0/h=0 makes the
      // Rust side SW_HIDE the HWND so it doesn't linger over UI when the
      // user clears the channel.
      ipc.mpvSetGeometry(0, 0, 0, 0).catch(() => {})
      return
    }
    // Open each pick exactly once. The Player remounts when coming back
    // from the Guide view (and React StrictMode re-runs effects in dev);
    // reopening then would reconnect — and providers that allow a single
    // connection reject the second one.
    const pb = usePlayback.getState()
    if (pb.loadedNonce === playNonce) return
    pb.markLoaded(playNonce)
    openCurrent(push, false)
  }, [channelId, playNonce, catchup, push])

  useConnectionKeeper(push)

  // 3) Mirror UI intent → mpv for volume/mute. Play/pause is *not* an
  //    effect: the store mirrors mpv's pause flag back into `playing`, and
  //    an effect on it would feed mpv's transient states straight back in
  //    (that loop used to pause streams while they were loading). The
  //    store's setPlaying talks to mpv directly instead.
  useEffect(() => {
    ipc.mpvSetVolume(muted ? 0 : volume).catch(() => {})
  }, [volume, muted])
  useEffect(() => {
    ipc.mpvSetMuted(muted).catch(() => {})
  }, [muted])

  // 5) VOD resume: save the last known position periodically + on channel
  //    switch. We track the last non-null position ourselves because by the
  //    time the cleanup runs, `play()` has already reset the store's
  //    timePos/duration for the next channel.
  useEffect(() => {
    if (!isVod || channelId === undefined) return
    const last = { timePos: null as number | null, duration: null as number | null }
    const unsubscribe = usePlayback.subscribe((s) => {
      if (s.channel?.id !== channelId) return
      if (s.timePos != null) last.timePos = s.timePos
      if (s.duration != null && s.duration > 0) last.duration = s.duration
    })
    const save = () => {
      const { timePos, duration } = last
      if (timePos == null || duration == null || duration <= 0) return
      // Near the end? Flag the row as finished but keep the entry so the
      // History view can show "Watched" badges. The sticky `finished` bit
      // in the DB means a re-watch that restarts won't reset this.
      const finished = timePos >= duration - END_GUARD
      // Don't store noise for the first few seconds — a misclick that
      // closes the player shouldn't stamp a fresh row that then outranks
      // the user's actual recent picks in the History list.
      if (!finished && timePos < 3) return
      useHistory
        .getState()
        .record(channelId, timePos, duration, finished)
        .catch(() => {})
    }
    const interval = window.setInterval(save, 5000)
    return () => {
      window.clearInterval(interval)
      unsubscribe()
      save() // final save on channel switch / unmount
    }
  }, [isVod, channelId])

  const lastCrashReload = useRef<{ channelId: number; at: number } | null>(null)
  // Double-click on the video rect routes through the native HWND → Rust →
  // this event. The HWND swallows pointer events before WebView2 can see
  // them, so an HTML `onDoubleClick` on the video div never fires; instead
  // the child window's wnd_proc catches WM_LBUTTONDBLCLK and Rust emits
  // `mpv://event`.
  //
  // `crashed` means the mpv process died. The next IPC call respawns it, so
  // reload the current channel from where it was — but only once per
  // channel per 30s, so a stream that reliably crashes mpv can't loop.
  useEffect(() => {
    return subscribe(() => onMpvEvent((ev) => {
      if (ev.kind === 'double-click') {
        // In the mini player a double-click restores the full window.
        const { fullscreen, mini, setFullscreen, setMini } = usePlayback.getState()
        if (mini) setMini(false)
        else setFullscreen(!fullscreen)
      } else if (ev.kind === 'crashed') {
        const { channel } = usePlayback.getState()
        if (!channel) return // nothing was playing; the next play respawns it
        const prev = lastCrashReload.current
        if (prev?.channelId === channel.id && Date.now() - prev.at < 30_000) {
          push('error', 'The player stopped unexpectedly.')
          return
        }
        lastCrashReload.current = { channelId: channel.id, at: Date.now() }
        push('info', 'The player stopped unexpectedly — restarting…')
        openCurrent(push, true)
      }
    }))
  }, [push])

  return null
}
