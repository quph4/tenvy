import {
  currentMonitor,
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  type PhysicalSize,
} from '@tauri-apps/api/window'

/**
 * Window choreography for the mini player: shrink to a small always-on-top
 * video window in the bottom-right corner, and put everything back exactly
 * as it was afterwards.
 */

const MINI_SIZE = new LogicalSize(480, 320)
/** Matches `minWidth`/`minHeight` in tauri.conf.json. */
const NORMAL_MIN_SIZE = new LogicalSize(960, 600)
const MARGIN = 24

// `setSize` sets the inner (client) size, so that's what we save too.
let saved: { size: PhysicalSize; position: PhysicalPosition; maximized: boolean } | null = null

export async function enterMiniWindow(): Promise<void> {
  const w = getCurrentWindow()
  saved = {
    size: await w.innerSize(),
    position: await w.outerPosition(),
    maximized: await w.isMaximized(),
  }
  if (saved.maximized) await w.unmaximize()
  await w.setMinSize(new LogicalSize(320, 200))
  await w.setSize(MINI_SIZE)
  await w.setAlwaysOnTop(true)

  const monitor = await currentMonitor()
  if (monitor) {
    const outer = await w.outerSize()
    const margin = Math.round(MARGIN * monitor.scaleFactor)
    await w.setPosition(
      new PhysicalPosition(
        monitor.position.x + monitor.size.width - outer.width - margin,
        // Leave room for the taskbar at the bottom of the screen.
        monitor.position.y + monitor.size.height - outer.height - margin * 3,
      ),
    )
  }
}

export async function exitMiniWindow(): Promise<void> {
  const w = getCurrentWindow()
  await w.setAlwaysOnTop(false)
  await w.setMinSize(NORMAL_MIN_SIZE)
  if (saved) {
    await w.setSize(saved.size)
    await w.setPosition(saved.position)
    if (saved.maximized) await w.maximize()
    saved = null
  }
}
