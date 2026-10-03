// Injected into the app's webview by run.mjs: small helpers the tests use.
// Everything goes through the app's own modules (Vite serves them), so the
// tests drive the same stores and IPC the UI does.
(() => {
  if (window.__t) return
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const t = {
    wait,
    /** Poll until fn() is truthy; return its value or throw `what`. */
    async until(fn, what, ms = 15000, step = 250) {
      const end = Date.now() + ms
      let last
      while (Date.now() < end) {
        try {
          last = await fn()
          if (last) return last
        } catch (e) {
          last = e
        }
        await wait(step)
      }
      throw new Error(`timed out: ${what} (last: ${String(last)})`)
    },
    pb: async () => (await import('/src/stores/playback.ts')).usePlayback,
    pl: async () => (await import('/src/stores/playlist.ts')).usePlaylist,
    ui: async () => (await import('/src/stores/ui.ts')).useUI,
    ipc: async () => (await import('/src/lib/ipc.ts')).ipc,
    text: () => document.body.innerText,
    /** Click the innermost visible element whose text is exactly `text`. */
    clickText(text, sel = 'button') {
      const all = [...document.querySelectorAll(sel)].filter((e) => e.textContent.trim() === text && e.offsetParent !== null)
      const el = all.find((e) => !all.some((o) => o !== e && e.contains(o))) ?? all[0]
      if (!el) throw new Error(`no ${sel} "${text}"`)
      el.click()
    },
    clickLabel(label) {
      const el = document.querySelector(`[aria-label="${label}"]`)
      if (!el) throw new Error(`no [aria-label="${label}"]`)
      el.click()
    },
    key(k, opts = {}, target = window) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }))
    },
    setInput(el, v) {
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      d.set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    },
    /** Every toast message seen since the helpers were injected. */
    toasts: [],
    async live(name) {
      const pl = await t.pl()
      return pl.getState().channels.find((c) => c.name === name)
    },
    /** Playing `name` and moving. */
    async playing(name, minPos = 1.5, ms = 20000) {
      const pb = await t.pb()
      return t.until(() => {
        const s = pb.getState()
        return s.channel?.name === name && (s.timePos ?? 0) > minPos && s
      }, `${name} playing`, ms)
    },
    async mute() {
      const pb = await t.pb()
      if (!pb.getState().muted) pb.getState().toggleMute()
      const ipc = await t.ipc()
      await ipc.mpvSetMuted(true).catch(() => {})
      await ipc.mpvSetVolume(0).catch(() => {})
    },
    async stop() {
      const pb = await t.pb()
      pb.getState().stop()
      await (await t.ipc()).mpvStop().catch(() => {})
    },
  }
  /** Close dialogs and leave fullscreen/mini, so each test starts clean. */
  t.reset = async () => {
    const ui = (await t.ui()).getState()
    if (ui.searchOpen) ui.closeSearch()
    if (ui.settingsOpen) ui.toggleSettings()
    if (ui.addSourceOpen) ui.closeAddSource()
    if (ui.manageCategoriesOpen) ui.setManageCategories(false)
    ;(await import('/src/stores/parental.ts')).useParental.getState().cancel()
    ;(await import('/src/components/ChannelMenu.tsx')).useChannelMenu.getState().close()
    const pb = (await t.pb()).getState()
    if (pb.pendingResume) pb.cancelResume()
    if (pb.mini) pb.setMini(false)
    if (pb.fullscreen) pb.setFullscreen(false)
    await t.wait(400)
  }

  /**
   * The app agrees with itself: the sidebar's categories belong to the
   * tab on screen, the list holds that tab's content, and the highlighted
   * tab is the active one. Returns a list of problems (empty = fine).
   */
  t.consistency = async () => {
    const problems = []
    const pl = (await t.pl()).getState()
    const ipc = await t.ipc()
    if (pl.sources.length === 0) return problems
    // Let pending loads settle.
    await t.until(async () => !(await t.pl()).getState().loadingChannels, 'lists settled', 8000).catch(() => {})
    const s = (await t.pl()).getState()
    const truth = (await ipc.listGroups(s.activeSourceId, s.activeKind)).map((g) => g.name).sort().join('|')
    const shown = s.groups.map((g) => g.name).sort().join('|')
    if (truth !== shown) problems.push(`categories don't match the ${s.activeKind} tab`)
    const own = s.activeGroup === '__favorites' || s.activeGroup === '__history'
    if (!own) {
      const wrong = s.channels.filter((c) => c.kind !== s.activeKind)
      if (wrong.length) problems.push(`${wrong.length} ${wrong[0].kind} item(s) listed under ${s.activeKind}`)
      if (s.activeGroup && s.channels.some((c) => (c.group ?? 'Uncategorized') !== s.activeGroup))
        problems.push(`items from another category listed under "${s.activeGroup}"`)
    }
    const ui = (await t.ui()).getState()
    const tabs = [...document.querySelectorAll('aside .grid button')]
    if (tabs.length === 3 && ui.view !== 'home') {
      const lit = tabs.findIndex((b) => b.className.includes('bg-neutral-800'))
      const want = ['live', 'movie', 'series'].indexOf(s.activeKind)
      if (lit !== -1 && lit !== want) problems.push(`tab ${lit} highlighted but ${s.activeKind} is active`)
    }
    return problems
  }

  import('/src/stores/toast.ts').then(({ useToast }) => {
    const seen = new Set()
    useToast.subscribe((s) =>
      s.items.forEach((x) => {
        if (!seen.has(x.id)) {
          seen.add(x.id)
          t.toasts.push(x.message)
        }
      }),
    )
  })
  window.__t = t
})()
