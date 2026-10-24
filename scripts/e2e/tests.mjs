// End-to-end checks, run in order against the local test provider by
// run.mjs. Each test gets `ctx`:
//   ctx.page(fn, args)  run fn(t, args) inside the app (t = page-helpers.js)
//   ctx.control(query)  the provider's /__control
//   ctx.reload()        reload the app's webview (keeps the library)
//   ctx.killMpv()       kill the app's mpv process
// A test fails by throwing; returning a string adds a note.

const PROVIDER = 'http://127.0.0.1:8788'

export const tests = [
  {
    name: 'First run: paste a provider link and import',
    run: (ctx) =>
      ctx.page(async (t, link) => {
        await t.until(() => t.text().includes('Connect your provider'), 'welcome page')
        const server = document.querySelector('form input')
        t.setInput(server, link)
        await t.wait(200)
        const fields = [...document.querySelectorAll('form input')].map((i) => i.value)
        if (fields[0] !== 'http://127.0.0.1:8788' || fields[1] !== 'test') throw new Error(`link not split: ${fields}`)
        document.querySelector('form button[type=submit]').click()
        await t.until(() => t.text().includes('all set'), 'import finished', 60000)
        const s = t.text()
        const n = (label) => Number(s.split(label)[1]?.match(/\d+/)?.[0])
        const got = { live: n('LIVE CHANNELS'), movies: n('MOVIES'), series: n('SERIES') }
        if (got.live !== 8 || got.movies !== 6 || got.series !== 2) throw new Error(`counts ${JSON.stringify(got)}`)
        t.clickText('Start watching')
        return `imported ${JSON.stringify(got)}`
      }, `${PROVIDER}/get.php?username=test&password=test&type=m3u_plus`),
  },
  {
    name: 'Home: rows and subscription status',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ui = await t.ui()
        ui.getState().setView('home')
        await t.until(() => t.text().includes('New movies') && t.text().includes('New series'), 'new rows')
        await t.until(() => /Expires .* days left/.test(t.text()), 'subscription chip')
      }),
  },
  {
    name: 'Remote config: announcement, support and community links',
    run: (ctx) =>
      ctx.page(async (t) => {
        await t.until(() => t.toasts.some((m) => m.includes('Hello from the test provider')), 'announcement', 20000)
        await t.until(() => [...document.querySelectorAll('footer button')].some((b) => b.textContent.includes('Support Tenvy')), 'support link in footer')
        await t.until(() => [...document.querySelectorAll('footer button')].some((b) => b.textContent.includes('Discord')), 'community link in footer')
        ;(await t.ui()).getState().toggleSettings()
        try {
          await t.until(() => [...document.querySelectorAll('aside button')].some((b) => b.textContent.startsWith('Discord') && b.textContent.includes('Questions')), 'community in About')
        } finally {
          ;(await t.ui()).getState().toggleSettings()
        }
      }),
  },
  {
    name: 'Store rating: asked after some days of use, at most twice, never after rating',
    run: (ctx) =>
      ctx.page(async (t) => {
        const m = await import('/src/stores/appInfo.ts')
        const day = 86400
        const now = 1_800_000_000
        const base = { store: true, installedAt: now - 6 * day, now, watched: true, busy: false, record: null }
        const cases = [
          ['first time, after a few days', base, true],
          ['installer version', { ...base, store: false }, false],
          ['only two days in', { ...base, installedAt: now - 2 * day }, false],
          ['nothing watched yet', { ...base, watched: false }, false],
          ['fullscreen or mini player', { ...base, busy: true }, false],
          ['asked ten days ago', { ...base, record: { asked: 1, at: now - 10 * day, rated: false } }, false],
          ['asked a month ago', { ...base, record: { asked: 1, at: now - 31 * day, rated: false } }, true],
          ['already rated', { ...base, record: { asked: 1, at: now - 31 * day, rated: true } }, false],
          ['asked twice', { ...base, record: { asked: 2, at: now - 90 * day, rated: false } }, false],
        ]
        const wrong = cases.filter(([, o, want]) => m.shouldAskForRating(o) !== want).map(([label]) => label)
        if (wrong.length) throw new Error(`wrong decision: ${wrong.join(', ')}`)

        // The request itself: a notice with a Rate button (not clicked: it opens the Store).
        const { useToast } = await import('/src/stores/toast.ts')
        try {
          m.askForRating()
          const toast = await t.until(
            () => useToast.getState().items.find((x) => x.message.includes('rating in the Microsoft Store')),
            'rating notice',
          )
          if (toast.action?.label !== 'Rate Tenvy') throw new Error(`button: ${toast.action?.label}`)
          const saved = JSON.parse(localStorage.getItem('tenvy.storeRating'))
          if (saved?.asked !== 1 || saved.rated) throw new Error(`recorded: ${JSON.stringify(saved)}`)
          useToast.getState().dismiss(toast.id)
        } finally {
          localStorage.removeItem('tenvy.storeRating')
        }
      }),
  },
  {
    name: 'Live: click a channel, it plays (sound muted)',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        ;(await t.ui()).getState().setView('player')
        await t.until(() => [...document.querySelectorAll('[role=button]')].some((r) => r.textContent.includes('Test One HD')), 'channel list')
        await t.mute()
        ;[...document.querySelectorAll('[role=button]')].find((r) => r.textContent.includes('Test One HD')).click()
        await t.wait(1500)
        await t.mute()
        await t.playing('Test One HD')
      }),
  },
  {
    name: 'Zapping: ↓, digits (headings skipped), Backspace',
    run: (ctx) =>
      ctx.page(async (t) => {
        t.key('ArrowDown')
        await t.playing('Test Two HD')
        t.key('5')
        await t.playing('Test Sport 2')
        t.key('Backspace')
        await t.playing('Test Two HD')
      }),
  },
  {
    name: 'Guide: day paging and catch-up from a programme card',
    run: (ctx) =>
      ctx.page(async (t) => {
        t.key('g')
        await t.until(() => document.querySelector('[aria-label="Next day"]'), 'guide')
        const day = () => t.text().match(/(\w{3}, \w{3} \d{1,2})/)?.[1]
        const today = day()
        t.clickLabel('Next day')
        await t.until(() => day() && day() !== today, 'next day')
        t.clickLabel('Previous day')
        await t.until(() => day() === today, 'back to today')
        // A programme that already aired on an archived channel.
        const label = [...document.querySelectorAll('span, div')].find((e) => e.textContent.trim() === 'Test One HD' && e.children.length === 0)
        const y = label.getBoundingClientRect().top + label.getBoundingClientRect().height / 2
        const nowX = document.querySelector('.bg-red-500\\/70').getBoundingClientRect().left
        const past = [...document.querySelectorAll('button')]
          .filter((b) => { const r = b.getBoundingClientRect(); return r.top < y && r.bottom > y && r.right < nowX - 5 && r.width > 40 })
          .pop()
        if (!past) throw new Error('no past programme on screen')
        past.click()
        await t.until(() => t.text().includes('Watch (catch-up)'), 'programme card')
        t.clickText('Watch (catch-up)')
        const pb = await t.pb()
        await t.until(() => pb.getState().catchup && (pb.getState().timePos ?? 0) > 2, 'catch-up playing', 20000)
      }),
  },
  {
    name: 'Guide: search narrows the rows, section titles left out',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        ;(await t.ui()).getState().setView('epg')
        await t.until(() => document.querySelector('input[aria-label="Find a channel in the guide"]'), 'guide search')
        const rowNames = () => [...document.querySelectorAll('.sticky.left-0.z-10 span.truncate')].map((e) => e.textContent)
        await t.until(() => rowNames().length >= 5, 'guide rows')
        if (rowNames().some((n) => n.includes('-='))) throw new Error('section title shown as a guide row')
        t.setInput(document.querySelector('input[aria-label="Find a channel in the guide"]'), 'sport')
        await t.until(() => rowNames().length === 2 && rowNames().every((n) => n.includes('Sport')), 'only Sport rows')
        t.setInput(document.querySelector('input[aria-label="Find a channel in the guide"]'), '')
        ;(await t.ui()).getState().setView('player')
      }),
  },
  {
    name: 'Guide times: an hour later moves the programmes, and back',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await t.until(() => pl.getState().channels.length, 'live list')
        const ch = pl.getState().channels.find((c) => c.name === 'Test One HD')
        const now = Math.floor(Date.now() / 1000)
        const [before] = await t.until(() => ipc.programmesForChannels({ tvgIds: [ch.tvgId], from: now, to: now + 1 }).then((r) => r.length && r), 'a programme now')
        ;(await t.ui()).getState().toggleSettings()
        const select = await t.until(() => document.querySelector('select[aria-label="Guide time adjustment"]:not([disabled])'), 'guide time setting')
        const choose = (v) => {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, String(v))
          select.dispatchEvent(new Event('change', { bubbles: true }))
        }
        try {
          choose(60)
          await t.until(async () => (await ipc.epgOffset()) === 60, 'saved')
          const [moved] = await ipc.programmesForChannels({ tvgIds: [ch.tvgId], from: before.start + 3600, to: before.start + 3601 })
          if (moved?.title !== before.title || moved.start !== before.start + 3600)
            throw new Error(`not moved: ${JSON.stringify(moved)} vs ${JSON.stringify(before)}`)
          choose(0)
          await t.until(async () => (await ipc.epgOffset()) === 0, 'back to as sent')
          const [again] = await ipc.programmesForChannels({ tvgIds: [ch.tvgId], from: now, to: now + 1 })
          if (again?.start !== before.start) throw new Error('not back')
        } finally {
          await ipc.setEpgOffset(0).catch(() => {})
          if ((await t.ui()).getState().settingsOpen) (await t.ui()).getState().toggleSettings()
        }
      }),
  },
  {
    name: 'Reminder fires a minute before start',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ipc = await t.ipc()
        const ch = await t.live('Test News 24')
        const now = Math.floor(Date.now() / 1000)
        await ipc.addReminder(ch.id, { start: now + 62, stop: now + 900, title: 'E2E reminder' })
        await (await import('/src/stores/reminders.ts')).useReminders.getState().load()
        await t.until(() => t.toasts.some((m) => m.includes('E2E reminder')), 'reminder toast', 30000)
        return 'a Windows notification was shown too'
      }),
  },
  {
    name: 'Search: Ctrl+K, type, Enter opens the film',
    run: (ctx) =>
      ctx.page(async (t) => {
        ;(await t.ui()).getState().setView('player')
        t.key('k', { ctrlKey: true })
        const input = await t.until(() => document.querySelector('input[placeholder^="Channels"]'), 'search box')
        t.setInput(input, 'signal lost')
        await t.until(() => t.text().includes('Signal Lost'), 'search result')
        t.key('Enter', {}, input)
        const pl = await t.pl()
        await t.until(() => pl.getState().selected?.type === 'movie', 'details page')
        await t.until(() => t.text().includes('Cee Codec'), 'film details (director)')
      }),
  },
  {
    name: 'Film: play, stop at 3:20, Resume prompt continues there',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('movie')
        ;(await t.ui()).getState().setView('player')
        await t.until(() => pl.getState().channels.length, 'movies')
        await pl.getState().openDetails(pl.getState().channels.find((c) => c.name.startsWith('Signal Lost')))
        await t.until(() => t.text().includes('Cee Codec'), 'details page')
        t.clickText('Play')
        await t.playing('Signal Lost (2025)')
        const ipc = await t.ipc()
        await ipc.mpvSeek(200)
        await t.until(async () => ((await t.pb()).getState().timePos ?? 0) > 205, 'past 3:25')
        await t.wait(6000) // progress is saved every 5 s
        const pb = await t.pb()
        const film = pb.getState().channel
        await t.stop()
        await t.wait(1000)
        pb.getState().requestPlay(film)
        await t.until(() => t.text().includes('Resume'), 'resume prompt')
        ;[...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Resume')).click()
        await t.until(() => (pb.getState().timePos ?? 0) > 195, 'resumed near 3:25', 20000)
      }),
  },
  {
    name: 'Series: seasons and an episode',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('series')
        await t.until(() => pl.getState().channels.length, 'series list')
        await pl.getState().openDetails(pl.getState().channels.find((c) => c.name === 'Reconnect'))
        await t.until(() => t.text().includes('Season 2'), 'seasons')
        t.clickText('Season 2')
        await t.wait(400)
        const ipc = await t.ipc()
        const show = pl.getState().channels.find((c) => c.name === 'Reconnect')
        const eps = await ipc.listEpisodes(show.id)
        ;(await t.pb()).getState().requestPlay(eps.find((e) => e.season === 2 && e.episode === 1))
        await t.playing('Reconnect S02E01')
      }),
  },
  {
    name: 'Series: the next episode starts by itself; Esc cancels the countdown',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        const pb = await t.pb()
        const up = (await import('/src/stores/upNext.ts')).useUpNext
        await pl.getState().setActiveKind('series')
        ;(await t.ui()).getState().setView('player')
        await t.until(() => pl.getState().channels.length, 'series list')
        const show = pl.getState().channels.find((c) => c.name === 'Reconnect')
        const eps = await ipc.listEpisodes(show.id)
        pb.getState().requestPlay(eps.find((e) => e.season === 1 && e.episode === 1))
        await t.playing('Reconnect S01E01')
        await t.until(() => up.getState().next?.name === 'Reconnect S01E02', 'next episode looked up')
        const toEnd = async () => {
          await ipc.mpvSeek((pb.getState().duration ?? 600) - 3)
          await t.until(() => up.getState().startsAt, 'countdown at the end', 20000)
        }
        await toEnd()
        await t.until(() => t.text().includes('Next episode in'), 'countdown on screen')
        t.key('Escape')
        await t.wait(300)
        if (up.getState().startsAt) throw new Error('Esc did not cancel the countdown')
        await t.wait(11000) // past the 10 s countdown: it stays cancelled
        if (pb.getState().channel?.name !== 'Reconnect S01E01') throw new Error('moved on although cancelled')
        // Watch the end again and let it run out.
        await ipc.mpvSeek((pb.getState().duration ?? 600) - 20)
        pb.getState().setPlaying(true)
        await t.until(() => !pb.getState().eofReached, 'playing again after seeking back')
        await toEnd()
        await t.playing('Reconnect S01E02', 0.5, 25000)
      }),
  },
  {
    name: 'Several audio tracks and subtitles (public test stream)',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('movie')
        await t.until(() => pl.getState().channels.length, 'movies')
        const film = pl.getState().channels.find((c) => c.name.startsWith('Tears of Steel'))
        ;(await t.pb()).getState().requestPlay(film)
        const s = await t.playing('Tears of Steel (2012)', 1, 40000)
        await t.mute()
        const pb = await t.pb()
        await t.wait(2000)
        const { audioTracks, subtitleTracks } = pb.getState()
        if (audioTracks.length < 2) return `only ${audioTracks.length} audio track — skipped switching`
        const ipc = await t.ipc()
        const other = audioTracks.find((a) => a.id !== pb.getState().currentAudio)
        await ipc.mpvSetAudioTrack(other.id)
        await t.until(() => pb.getState().currentAudio === other.id, 'audio track switched')
        if (subtitleTracks.length) {
          await ipc.mpvSetSubtitleTrack(subtitleTracks[0].id)
          await t.until(() => pb.getState().currentSubtitle === subtitleTracks[0].id, 'subtitles on')
        }
        void s
        return `${audioTracks.length} audio, ${subtitleTracks.length} subtitle tracks`
      }),
  },
  {
    name: 'Tabs: series → Live → Shows keeps the right categories',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        const ui = (await t.ui()).getState()
        ui.setView('player')
        await pl.getState().setActiveKind('series')
        await t.until(() => pl.getState().channels.length, 'shows')
        await pl.getState().setActiveGroup('Test Series')
        await pl.getState().openDetails(pl.getState().channels.find((c) => c.name === 'The Guide'))
        const ipc = await t.ipc()
        const show = pl.getState().channels.find((c) => c.name === 'The Guide')
        const eps = await ipc.listEpisodes(show.id)
        ;(await t.pb()).getState().requestPlay(eps[0])
        await t.playing(eps[0].name)
        // Over to Live and back, by clicking the tabs like a viewer.
        const tab = (label) => [...document.querySelectorAll('aside .grid button')].find((b) => b.textContent.trim().toLowerCase() === label).click()
        await t.stop()
        tab('live')
        await t.wait(600)
        let p = await t.consistency()
        if (p.length) throw new Error(`after Live: ${p.join('; ')}`)
        tab('shows')
        await t.wait(600)
        p = await t.consistency()
        if (p.length) throw new Error(`back on Shows: ${p.join('; ')}`)
        if (!t.text().includes('The Guide')) throw new Error('shows not listed')
      }),
  },
  {
    name: 'Tabs and categories: rapid switching with slow answers',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        ;(await t.ui()).getState().setView('player')
        // Answers arrive late and out of order, like a slow PC or a busy
        // database — exactly when stale answers used to win.
        const orig = { listGroups: ipc.listGroups, listChannels: ipc.listChannels, listFavorites: ipc.listFavorites }
        for (const k of Object.keys(orig))
          ipc[k] = async (...a) => {
            const r = await orig[k].apply(ipc, a)
            await t.wait(Math.random() * 500)
            return r
          }
        const problems = []
        try {
          const steps = ['live', 'series', 'movie', 'live', 'movie', 'series', 'live', 'series']
          for (let round = 0; round < 3; round++) {
            for (const k of steps) {
              pl.getState().setActiveKind(k) // not awaited: the viewer clicks on
              await t.wait(Math.random() * 150)
            }
            const groups = await orig.listGroups.call(ipc, pl.getState().activeSourceId, pl.getState().activeKind)
            if (groups[0]) pl.getState().setActiveGroup(groups[0].name)
            pl.getState().setActiveGroup(null)
            pl.getState().setActiveGroup('__favorites')
            pl.getState().setActiveGroup(null)
            await t.wait(1500)
            problems.push(...(await t.consistency()).map((x) => `round ${round + 1}: ${x}`))
          }
        } finally {
          Object.assign(ipc, orig)
        }
        if (problems.length) throw new Error(problems.join('; '))
      }),
  },
  {
    name: 'Leaving the player: Now playing bar everywhere; its Stop really stops',
    run: async (ctx) => {
      await ctx.page(async (t) => {
        const pl = await t.pl()
        const ui = (await t.ui()).getState()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        ui.setView('player')
        ;(await t.pb()).getState().play(await t.live('Test News 24'))
        await t.playing('Test News 24')
        const bar = () => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Back to player'))
        // Movies tab, Home and the guide all show what's playing.
        ;[...document.querySelectorAll('aside .grid button')].find((b) => b.textContent.trim().toLowerCase() === 'movies').click()
        await t.until(bar, 'bar in the library')
        ui.setView('home')
        await t.until(bar, 'bar on Home')
        ui.setView('epg')
        await t.until(bar, 'bar in the guide')
        // Back to player brings it back on screen.
        t.clickText('Back to player')
        await t.until(async () => (await t.ui()).getState().view === 'player' && (await t.pl()).getState().activeKind === 'live', 'player on screen')
        if (bar()) throw new Error('bar still shown with the player on screen')
        ui.setView('home')
        await t.until(bar, 'bar on Home again')
        t.clickText('Stop')
        await t.until(async () => !(await t.pb()).getState().channel, 'stopped')
      })
      let s
      for (let i = 0; i < 10; i++) {
        s = await ctx.control('')
        if (s.openStreams === 0) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (s.openStreams !== 0) throw new Error(`${s.openStreams} stream(s) still open after Stop`)
    },
  },
  {
    name: 'The player’s Library button stops the film for real',
    run: async (ctx) => {
      await ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('movie')
        ;(await t.ui()).getState().setView('player')
        await t.until(() => pl.getState().channels.length, 'movies')
        ;(await t.pb()).getState().requestPlay(pl.getState().channels.find((c) => c.name.startsWith('Color Bars')))
        await t.playing('Color Bars Forever (2024)')
        document.querySelector('button[title="Stop and go back to the library"]').click()
        await t.until(async () => !(await t.pb()).getState().channel, 'film stopped')
        await t.until(() => t.text().includes('All movies'), 'library on screen')
      })
      let s
      for (let i = 0; i < 10; i++) {
        s = await ctx.control('')
        if (s.openStreams === 0) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (s.openStreams !== 0) throw new Error(`${s.openStreams} stream(s) still open — the film kept playing`)
    },
  },
  {
    name: 'Fast zapping then Stop: nothing left playing or open',
    run: async (ctx) => {
      await ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        ;(await t.ui()).getState().setView('player')
        const pb = await t.pb()
        pb.getState().play(await t.live('Test One HD'))
        await t.playing('Test One HD')
        for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown']) {
          t.key(k)
          await t.wait(120)
        }
        pb.getState().stop() // while those loads are still on their way
        await t.wait(4000)
        if (pb.getState().channel) throw new Error('something is still selected')
      })
      let s
      for (let i = 0; i < 10; i++) {
        s = await ctx.control('')
        if (s.openStreams === 0) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (s.openStreams !== 0) throw new Error(`${s.openStreams} stream(s) open after Stop — a late load won`)
    },
  },
  {
    name: 'A live channel picked from Movies → Favorites plays (with the bar)',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        const ch = await t.live('Test Kids')
        const favs = await ipc.listFavorites()
        const added = !favs.some((c) => c.id === ch.id)
        if (added) await ipc.toggleFavorite(ch.id)
        await pl.getState().setActiveKind('movie')
        ;(await t.ui()).getState().setView('player')
        await pl.getState().setActiveGroup('__favorites')
        await t.until(() => pl.getState().channels.some((c) => c.name === 'Test Kids'), 'favorite listed')
        ;(await t.pb()).getState().play(pl.getState().channels.find((c) => c.name === 'Test Kids'))
        await t.playing('Test Kids')
        await t.until(() => t.text().includes('Back to player') || !!document.querySelector('button[aria-label="Pause"]'), 'bar or player visible')
        await t.stop()
        if (added) await ipc.toggleFavorite(ch.id) // leave favorites as they were
        await pl.getState().setActiveGroup(null)
      }),
  },
  {
    name: 'Arrow keys in the guide scroll; they don’t zap a hidden player',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        const ui = (await t.ui()).getState()
        ui.setView('player')
        const pb = await t.pb()
        pb.getState().play(await t.live('Test Two HD'))
        await t.playing('Test Two HD')
        ui.setView('epg')
        await t.wait(500)
        t.key('ArrowDown')
        t.key('5')
        await t.wait(2500)
        if (pb.getState().channel?.name !== 'Test Two HD') throw new Error(`zapped to ${pb.getState().channel?.name} behind the guide`)
        await t.stop()
        ui.setView('player')
      }),
  },
  {
    name: 'Opening another title while a film plays shows its page',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('movie')
        ;(await t.ui()).getState().setView('player')
        await t.until(() => pl.getState().channels.length, 'movies')
        ;(await t.pb()).getState().requestPlay(pl.getState().channels.find((c) => c.name.startsWith('Buffering')))
        await t.playing('Buffering (2023)')
        // From search, say: a show's page.
        const ipc = await t.ipc()
        const show = (await ipc.searchChannels('reconnect')).find((c) => c.kind === 'series')
        await pl.getState().openDetails(show)
        await t.until(() => t.text().includes('Season 2'), 'show page visible')
        if ((await t.pb()).getState().channel) throw new Error('film still playing behind the page')
      }),
  },
  {
    name: 'Diagnostics: useful and free of logins',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        ;(await t.ui()).getState().setView('player')
        ;(await t.pb()).getState().play(await t.live('Test One HD'))
        await t.playing('Test One HD')
        const text = await (await t.ipc()).diagnostics()
        for (const want of ['Tenvy ', 'Providers:', 'xtream', 'Library:', 'log lines'])
          if (!text.includes(want)) throw new Error(`missing "${want}"`)
        for (const leak of ['/live/test/test/', 'username=test', 'password=test'])
          if (text.includes(leak)) throw new Error(`leaks "${leak}"`)
        await t.stop()
        return `${text.split(/\r?\n/).length} lines`
      }),
  },
  {
    name: 'Picture & sound panel: shape and stream details',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        ;(await t.ui()).getState().setView('player')
        ;(await t.pb()).getState().play(await t.live('Test Kids'))
        await t.playing('Test Kids')
        t.clickLabel('Picture and sound')
        await t.until(() => /1280×720/.test(t.text()), 'stream details in panel')
        t.clickText('Fill')
        const ipc = await t.ipc()
        await t.until(async () => (await ipc.mpvStreamInfo()).panscan === 1, 'fill applied')
        t.clickText('Auto')
        await t.until(async () => (await ipc.mpvStreamInfo()).panscan === 0, 'auto restored')
        t.clickLabel('Picture and sound')
      }),
  },
  {
    name: 'Sleep timer stops playback',
    run: (ctx) =>
      ctx.page(async (t) => {
        ;(await import('/src/stores/sleep.ts')).useSleep.getState().set(0.1)
        const pb = await t.pb()
        await t.until(() => !pb.getState().channel, 'playback stopped', 20000)
      }),
  },
  {
    name: 'Mini player (P) and fullscreen (F / Esc)',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        ;(await t.ui()).getState().setView('player')
        const pb = await t.pb()
        pb.getState().play(await t.live('Test One HD'))
        await t.playing('Test One HD')
        t.key('p')
        await t.until(() => pb.getState().mini, 'mini on')
        await t.wait(1500)
        t.key('p')
        await t.until(() => !pb.getState().mini, 'mini off')
        await t.wait(1000)
        t.key('f')
        await t.until(() => pb.getState().fullscreen, 'fullscreen on')
        await t.wait(1500)
        t.key('Escape')
        await t.until(() => !pb.getState().fullscreen, 'fullscreen off')
      }),
  },
  {
    name: 'Favorites: add from the ⋯ menu, reorder, hide and bring back',
    run: (ctx) =>
      ctx.page(async (t) => {
        const pl = await t.pl()
        const { useChannelMenu } = await import('/src/components/ChannelMenu.tsx')
        const menu = async (name, action) => {
          useChannelMenu.getState().show(pl.getState().channels.find((c) => c.name === name), 200, 200)
          await t.wait(250)
          t.clickText(action)
          await t.wait(700)
        }
        await pl.getState().setActiveGroup(null)
        for (const n of ['Test One HD', 'Test Two HD', 'Test Kids']) await menu(n, 'Add to favorites')
        await pl.getState().setActiveGroup('__favorites')
        await t.until(() => pl.getState().channels.length === 3, 'three favorites')
        await menu('Test Kids', 'Move up')
        const order = pl.getState().channels.map((c) => c.name).join(', ')
        if (order !== 'Test One HD, Test Kids, Test Two HD') throw new Error(`order: ${order}`)
        await pl.getState().setActiveGroup(null)
        await menu('Test Weather', 'Hide channel')
        if (pl.getState().channels.some((c) => c.name === 'Test Weather')) throw new Error('still listed after hiding')
        const ipc = await t.ipc()
        const hidden = await ipc.listHiddenChannels()
        await ipc.setChannelHidden(hidden[0].id, false)
        await pl.getState().refreshChannels()
        if (!pl.getState().channels.some((c) => c.name === 'Test Weather')) throw new Error('not back after showing')
      }),
  },
  {
    name: 'Categories: hide one, lock one behind a PIN, unlock with the prompt',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        const par = (await import('/src/stores/parental.ts')).useParental
        const sid = pl.getState().sources[0].id
        await pl.getState().setActiveKind('live')
        ;(await t.ui()).getState().setView('player')
        try {
        await ipc.setGroupPrefs({ sourceId: sid, kind: 'live', names: ['Test News'], hidden: true })
        await par.getState().setPin(null, '2468')
        await ipc.setGroupPrefs({ sourceId: sid, kind: 'live', names: ['For Adults'], locked: true })
        await pl.getState().hydrate()
        const names = pl.getState().channels.map((c) => c.name)
        if (names.includes('Test News 24') || names.includes('Test Late Night')) throw new Error(`still listed: ${names}`)
        const btn = [...document.querySelectorAll('aside button')].find((b) => b.textContent.startsWith('For Adults'))
        btn.click()
        const pin = await t.until(() => document.querySelector('input[inputmode="numeric"]'), 'PIN prompt')
        t.setInput(pin, '2468')
        await t.wait(100)
        t.clickText('Unlock')
        await t.until(() => pl.getState().activeGroup === 'For Adults' && pl.getState().channels.some((c) => c.name === 'Test Late Night'), 'locked category open')
        } finally {
          // Undo, whatever happened.
          await par.getState().lock().catch(() => {})
          await ipc.parentalUnlock('2468').catch(() => {})
          await par.getState().setPin('2468', null).catch(() => {})
          await ipc.setGroupPrefs({ sourceId: sid, kind: 'live', names: ['For Adults'], locked: false }).catch(() => {})
          await ipc.setGroupPrefs({ sourceId: sid, kind: 'live', names: ['Test News'], hidden: false }).catch(() => {})
          await pl.getState().setActiveGroup(null)
          await pl.getState().hydrate()
        }
      }),
  },
  {
    name: 'Parental keywords: a word locks matching categories and titles',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        const par = (await import('/src/stores/parental.ts')).useParental
        await pl.getState().setActiveKind('live')
        ;(await t.ui()).getState().setView('player')
        await pl.getState().setActiveGroup(null)
        await t.until(() => pl.getState().channels.some((c) => c.name === 'Test Late Night'), 'live list')
        const late = pl.getState().channels.find((c) => c.name === 'Test Late Night')
        try {
          await par.getState().setPin(null, '1357')
          ;(await t.ui()).getState().toggleSettings()
          const input = await t.until(() => document.querySelector('input[aria-label="New keyword"]'), 'keyword field')
          t.setInput(input, 'Adults')
          await t.wait(100)
          input.form.requestSubmit()
          // Changing keywords asks for the PIN.
          const pin = await t.until(() => document.querySelector('input[inputmode="numeric"]'), 'PIN prompt')
          t.setInput(pin, '1357')
          await t.wait(100)
          t.clickText('Unlock')
          await t.until(() => par.getState().words.includes('adults'), 'keyword saved (lowercase)')
          await t.until(() => [...document.querySelectorAll('[aria-label="Keywords"] li')].some((li) => li.textContent.includes('adults')), 'keyword listed')
          ;(await t.ui()).getState().toggleSettings()

          await par.getState().lock()
          await t.until(() => !pl.getState().loadingChannels && !pl.getState().channels.some((c) => c.name === 'Test Late Night'), 'title left out')
          const adults = (await ipc.listGroups(late.sourceId, 'live')).find((g) => g.name === 'For Adults')
          if (!adults?.locked || !adults.lockedByWord) throw new Error(`category not locked by the word: ${JSON.stringify(adults)}`)
          if ((await ipc.searchChannels('Late')).length) throw new Error('found by search while locked')
          if (!(await ipc.isChannelLocked(late.id))) throw new Error('playable while locked')
          if (await ipc.isChannelLocked(pl.getState().channels.find((c) => c.name === 'Test One HD').id)) throw new Error('an unrelated channel is locked')

          await ipc.parentalUnlock('1357')
          await par.getState().refresh()
          await pl.getState().hydrate()
          await t.until(() => pl.getState().channels.some((c) => c.name === 'Test Late Night'), 'back with the PIN')
        } finally {
          await ipc.parentalUnlock('1357').catch(() => {})
          await ipc.setParentalWords([]).catch(() => {})
          await par.getState().setPin('1357', null).catch(() => {})
          await par.getState().loadWords().catch(() => {})
          if ((await t.ui()).getState().settingsOpen) (await t.ui()).getState().toggleSettings()
          await pl.getState().hydrate()
        }
      }),
  },
  {
    name: 'Provider: rename and refresh keep favorites',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        const sid = pl.getState().sources[0].id
        await ipc.renameSource(sid, 'Test provider')
        await ipc.refreshSource(sid)
        await pl.getState().hydrate()
        if (pl.getState().sources[0].name !== 'Test provider') throw new Error('not renamed')
        const favs = await ipc.listFavorites()
        if (favs.length !== 3) throw new Error(`favorites after refresh: ${favs.length}`)
      }),
  },
  {
    name: 'Daily refresh: a day-old provider is re-imported quietly',
    run: (ctx) =>
      ctx.page(async (t) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        const id = pl.getState().sources[0].id
        const before = (await ipc.listSources())[0].updatedAt
        // Two imports of one provider at once are refused.
        const both = await Promise.allSettled([ipc.refreshSource(id), ipc.refreshSource(id)])
        if (!both.some((r) => r.status === 'rejected' && String(r.reason).includes('already'))) throw new Error('second import was not refused')
        // Pretend the last import was two days ago, then let the check run.
        pl.setState({ sources: pl.getState().sources.map((s) => ({ ...s, updatedAt: s.updatedAt - 2 * 86400 })) })
        const { autoRefreshNow } = await import('/src/stores/autoRefresh.ts')
        await autoRefreshNow()
        const after = (await ipc.listSources())[0].updatedAt
        if (!(after >= before)) throw new Error(`not re-imported (${before} → ${after})`)
        if ((await import('/src/stores/ingest.ts')).useIngest.getState().status) throw new Error('import overlay shown for a background refresh')
        if ((await ipc.listFavorites()).length !== 3) throw new Error('favorites lost')
      }),
  },
  {
    name: 'Second provider: plain M3U playlist with its guide',
    run: (ctx) =>
      ctx.page(async (t, url) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        const src = await ipc.addSource({ kind: 'm3u', name: 'M3U test', url })
        if (src.kind !== 'm3u') throw new Error(`kind ${src.kind}`)
        await pl.getState().hydrate()
        await pl.getState().setActiveSource(src.id)
        await t.until(() => pl.getState().channels.some((c) => c.name === 'M3U Test One HD'), 'M3U channels')
        const pb = await t.pb()
        pb.getState().play(pl.getState().channels.find((c) => c.name === 'M3U Test One HD'))
        await t.playing('M3U Test One HD')
        const now = await t.until(async () => (await ipc.nowPlaying(['test.101'])).length, 'guide for M3U', 30000)
        // Removing the provider of what's playing stops it (via Settings).
        ;(await t.ui()).getState().toggleSettings()
        await t.until(() => [...document.querySelectorAll('button[aria-label="Remove"]')].length === 2, 'two providers listed')
        ;[...document.querySelectorAll('button[aria-label="Remove"]')][1].click()
        await t.until(async () => (await ipc.listSources()).length === 1, 'provider removed')
        if ((await t.pb()).getState().channel) throw new Error('still playing the removed provider')
        ;(await t.ui()).getState().toggleSettings()
        await pl.getState().setActiveSource(pl.getState().sources[0].id)
        await pl.getState().hydrate()
        if ((await ipc.listSources()).length !== 1) throw new Error('second provider not removed')
        void now
      }, `${PROVIDER}/playlist.m3u`),
  },
  {
    name: 'Backup: save, lose things, restore them (with a removed provider)',
    run: (ctx) =>
      ctx.page(async (t, url) => {
        const ipc = await t.ipc()
        const pl = await t.pl()
        const ui = async () => (await t.ui()).getState()
        await pl.getState().setActiveKind('live')
        await t.until(() => pl.getState().channels.length, 'live list')
        const kids = pl.getState().channels.find((c) => c.name === 'Test Kids')
        const weather = pl.getState().channels.find((c) => c.name === 'Test Weather')
        const isFav = async () => (await ipc.listFavorites()).some((c) => c.id === kids.id)
        const isHidden = async () => (await ipc.listHiddenChannels()).some((c) => c.id === weather.id)
        const extra = async () => (await ipc.listSources()).find((s) => s.name === 'M3U backup')
        const wasFav = await isFav()
        try {
          await ipc.addSource({ kind: 'm3u', name: 'M3U backup', url })
          if (!wasFav) await ipc.toggleFavorite(kids.id)
          await ipc.setChannelHidden(weather.id, true)
          await pl.getState().hydrate()

          ;(await ui()).toggleSettings()
          await t.until(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Save a backup')), 'backup section')
          // Settings scroll: the last section can be reached on any screen.
          const panel = [...document.querySelectorAll('aside')].find((a) => a.textContent.includes('Save a backup'))
          const scroller = panel.querySelector('.overflow-y-auto')
          scroller.scrollTop = scroller.scrollHeight
          await t.wait(100)
          const last = [...panel.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Copy diagnostics')
          if (!last || last.getBoundingClientRect().bottom > innerHeight) throw new Error("Settings don't scroll to the end")
          t.clickText('Save a backup…')
          await t.until(() => t.text().includes('Saved to'), 'saved')

          // Lose them.
          await ipc.toggleFavorite(kids.id)
          await ipc.setChannelHidden(weather.id, false)
          await ipc.removeSource((await extra()).id)
          await pl.getState().hydrate()
          if ((await isFav()) || (await isHidden()) || (await extra())) throw new Error('not undone')

          t.clickText('Restore from a backup…')
          await t.until(() => t.text().includes('Restored'), 'restored', 60000)
          const note = t.text()
          if (!note.includes('1 provider added')) throw new Error(`provider not re-added: ${note.slice(note.indexOf('Restored'), note.indexOf('Restored') + 160)}`)
          if (!(await isFav())) throw new Error('favorite not back')
          if (!(await isHidden())) throw new Error('hidden channel not back')
          const back = await extra()
          if (!back) throw new Error('provider not back')
          if (!(await ipc.sourceStats(back.id)).live) throw new Error('re-added provider has no channels')
          if (!pl.getState().sources.some((s) => s.id === back.id)) throw new Error('sidebar not refreshed')
        } finally {
          const left = await extra()
          if (left) await ipc.removeSource(left.id).catch(() => {})
          if ((await isFav()) !== wasFav) await ipc.toggleFavorite(kids.id).catch(() => {})
          await ipc.setChannelHidden(weather.id, false).catch(() => {})
          if ((await ui()).settingsOpen) (await ui()).toggleSettings()
          await pl.getState().setActiveSource(pl.getState().sources[0].id)
          await pl.getState().hydrate()
        }
      }, `${PROVIDER}/playlist.m3u`),
  },
  {
    name: 'Start with the last channel',
    run: async (ctx) => {
      await ctx.page(async (t) => {
        ;(await import('/src/stores/tvPrefs.ts')).useTvPrefs.getState().setStartWithLastChannel(true)
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        ;(await t.pb()).getState().play(await t.live('Test Sport 1'))
        await t.playing('Test Sport 1')
        await t.wait(1500)
        await t.stop()
      })
      await ctx.reload()
      await ctx.page(async (t) => {
        await t.mute()
        await t.playing('Test Sport 1', 1, 30000)
        await t.mute()
        ;(await import('/src/stores/tvPrefs.ts')).useTvPrefs.getState().setStartWithLastChannel(false)
      })
    },
  },
  {
    name: 'Player crash: mpv is restarted and playback resumes',
    run: async (ctx) => {
      await ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        ;(await t.ui()).getState().setView('player')
        const pb = (await t.pb()).getState()
        if (pb.channel?.name !== 'Test Sport 1') pb.play(await t.live('Test Sport 1'))
        await t.playing('Test Sport 1', 1)
      })
      await ctx.killMpv()
      await ctx.page(async (t) => {
        await t.until(() => t.toasts.some((m) => m.includes('restarting')), 'restart notice', 20000)
        await t.mute()
        await t.playing('Test Sport 1', 1, 30000)
        await t.mute()
      })
    },
  },
  {
    name: 'Provider down at startup: library still opens from cache',
    run: async (ctx) => {
      const before = await ctx.page(async (t) => {
        await t.stop()
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        await pl.getState().setActiveGroup(null)
        return pl.getState().channels.length
      })
      await ctx.control('down=1')
      await ctx.reload()
      await ctx.page(async (t, before) => {
        const pl = await t.pl()
        await t.until(() => pl.getState().sources.length === 1, 'sources')
        ;(await t.ui()).getState().setView('player')
        await pl.getState().setActiveKind('live')
        await t.until(() => pl.getState().channels.length === before, `${before} channels from cache`)
      }, before)
      await ctx.control('down=0')
    },
  },
  {
    name: 'Stream drops and stalls recover by themselves',
    run: async (ctx) => {
      await ctx.page(async (t) => {
        await t.mute()
        ;(await t.pb()).getState().play(await t.live('Test Two HD'))
        await t.playing('Test Two HD')
      })
      await ctx.control('drop=1&fail=1')
      await ctx.page(async (t) => {
        await t.wait(4000)
        const pb = await t.pb()
        const p0 = pb.getState().timePos ?? 0
        await t.until(() => (pb.getState().timePos ?? 0) > p0 + 3 || (pb.getState().timePos ?? 0) < p0, 'moving after drop', 30000)
      })
      await ctx.control('stall=1')
      await new Promise((r) => setTimeout(r, 22000))
      await ctx.control('stall=0')
      await ctx.page(async (t) => {
        await t.mute()
        await t.playing('Test Two HD', 1, 40000)
        await t.stop()
      })
    },
  },
]
