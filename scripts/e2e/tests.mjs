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
    name: 'Remote config: announcement and support link',
    run: (ctx) =>
      ctx.page(async (t) => {
        await t.until(() => t.toasts.some((m) => m.includes('Hello from the test provider')), 'announcement', 20000)
        await t.until(() => [...document.querySelectorAll('footer button')].some((b) => b.textContent.includes('Support Tenvy')), 'support link in footer')
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
        const day = () => t.text().match(/GUIDE\s+(\w+, \w+ \d+)/)?.[1]
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
    name: 'Going to Movies stops live TV (no sound behind the library)',
    run: async (ctx) => {
      await ctx.page(async (t) => {
        const pl = await t.pl()
        await pl.getState().setActiveKind('live')
        ;(await t.ui()).getState().setView('player')
        ;(await t.pb()).getState().play(await t.live('Test News 24'))
        await t.playing('Test News 24')
        ;[...document.querySelectorAll('aside .grid button')].find((b) => b.textContent.trim().toLowerCase() === 'movies').click()
        const pb = await t.pb()
        await t.until(() => !pb.getState().channel, 'live stopped')
      })
      // The connection closes a moment after the stop.
      let s
      for (let i = 0; i < 10; i++) {
        s = await ctx.control('')
        if (s.openStreams === 0) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (s.openStreams !== 0) throw new Error(`${s.openStreams} stream(s) still open at the provider after 5 s`)
    },
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
        await t.stop()
        await ipc.removeSource(src.id)
        await pl.getState().setActiveSource(pl.getState().sources[0].id)
        await pl.getState().hydrate()
        if ((await ipc.listSources()).length !== 1) throw new Error('second provider not removed')
        void now
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
