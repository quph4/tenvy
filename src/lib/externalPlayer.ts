import { ipc } from './ipc'
import { usePlayback } from '../stores/playback'

/**
 * Hand the current channel to an external mpv/VLC window, keeping the
 * selected audio/subtitle tracks.
 *
 * The embedded stream is stopped first: many providers allow a single
 * connection, and the external player would otherwise be refused while
 * ours is still open. Returns the launched player's path.
 */
export async function openInExternalPlayer(): Promise<string> {
  const pb = usePlayback.getState()
  const channel = pb.channel
  if (!channel) throw new Error('Nothing is playing')
  // Prefer what mpv is *actually* playing right now so in-app picks carry
  // over; fall back to the saved preference if mpv hasn't reported tracks.
  const audioTrack = pb.currentAudio ?? pb.preferredAudioTrack
  const subtitleTrack = pb.currentSubtitle ?? pb.preferredSubtitleTrack

  pb.stop()
  // Give the provider a moment to see our connection close.
  await new Promise((r) => setTimeout(r, 500))
  return ipc.openExternal(channel.id, { audioTrack, subtitleTrack })
}
