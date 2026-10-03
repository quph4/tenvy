(() => {
  const css = `
  #__cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; width: 26px; height: 26px;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,.6)); transition-property: transform; transition-timing-function: cubic-bezier(.45,.05,.25,1); }
  #__ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 44px; height: 44px; margin: -22px 0 0 -22px;
    border-radius: 50%; border: 2px solid rgba(212,180,124,.9); opacity: 0; }
  #__ripple.on { animation: __rip .5s ease-out; }
  @keyframes __rip { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.4); opacity: 0 } }
  #__cap { position: fixed; left: 50%; bottom: 54px; z-index: 2147483640; pointer-events: none;
    transform: translate(-50%, 16px); opacity: 0; transition: opacity .45s, transform .45s;
    padding: 14px 26px; border-radius: 999px; background: rgba(12,12,12,.86); backdrop-filter: blur(10px);
    border: 1px solid rgba(212,180,124,.35); box-shadow: 0 20px 60px rgba(0,0,0,.6);
    font: 600 26px/1.2 Inter, 'Segoe UI', sans-serif; color: #f5f0e6; letter-spacing: -.01em; white-space: nowrap; }
  #__cap.on { opacity: 1; transform: translate(-50%, 0); }
  #__card { position: fixed; inset: 0; z-index: 2147483645; display: grid; place-items: center; pointer-events: none;
    background: radial-gradient(900px 500px at 50% 40%, rgba(212,180,124,.14), transparent 70%), #0a0a0a;
    opacity: 0; transition: opacity .7s; font-family: Inter, 'Segoe UI', sans-serif; text-align: center; color: #f5f5f5; }
  #__card.on { opacity: 1; }
  #__card img { width: 112px; height: 112px; border-radius: 26px; margin: 0 auto 30px; box-shadow: 0 30px 80px rgba(0,0,0,.7); }
  #__card h1 { margin: 0; font-size: 78px; font-weight: 700; letter-spacing: -.035em; line-height: 1.05; }
  #__card h1 em { font-style: normal; color: #d4b47c; }
  #__card p { margin: 22px 0 0; font-size: 26px; color: #a3a3a3; }
  #__card .pill { display: inline-block; margin-top: 34px; padding: 14px 28px; border-radius: 14px; background: #d4b47c; color: #0a0a0a; font-weight: 700; font-size: 24px; }
  #__card .url { margin-top: 18px; font-size: 20px; color: #737373; }
  #__card .in { animation: __in .9s cubic-bezier(.2,.7,.2,1) both; }
  @keyframes __in { from { opacity: 0; transform: translateY(18px) } to { opacity: 1; transform: none } }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)

  const cursor = document.createElement('div')
  cursor.id = '__cursor'
  cursor.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2.5v17.2l4.6-4.4 3 6.7 3-1.3-3-6.6h6.4z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>`
  document.body.appendChild(cursor)
  const ripple = document.createElement('div')
  ripple.id = '__ripple'
  document.body.appendChild(ripple)
  const cap = document.createElement('div')
  cap.id = '__cap'
  document.body.appendChild(cap)
  const card = document.createElement('div')
  card.id = '__card'
  document.body.appendChild(card)

  let pos = { x: innerWidth * 0.62, y: innerHeight * 0.55 }
  const place = () => (cursor.style.transform = `translate(${pos.x - 4}px, ${pos.y - 2}px)`)
  place()

  const center = (el) => {
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
  }
  const ICON = '/src-tauri/icons/app-icon.svg'

  window.__d = {
    cursorTo(x, y, ms) {
      cursor.style.transitionDuration = ms + 'ms'
      pos = { x, y }
      place()
    },
    ripple() {
      ripple.style.left = pos.x + 'px'
      ripple.style.top = pos.y + 'px'
      ripple.classList.remove('on')
      void ripple.offsetWidth
      ripple.classList.add('on')
    },
    caption(text) {
      if (!text) return cap.classList.remove('on')
      if (cap.classList.contains('on')) {
        cap.classList.remove('on')
        setTimeout(() => {
          cap.textContent = text
          cap.classList.add('on')
        }, 320)
      } else {
        cap.textContent = text
        cap.classList.add('on')
      }
    },
    titleCard(on) {
      if (on) {
        card.innerHTML = `<div><img class="in" src="${ICON}"><h1 class="in" style="animation-delay:.15s">Your IPTV,<br><em>beautifully</em> organised.</h1><p class="in" style="animation-delay:.35s">Tenvy — the IPTV player for Windows</p></div>`
        card.style.transition = 'none'
        card.classList.add('on')
        void card.offsetWidth
        card.style.transition = ''
      } else card.classList.remove('on')
    },
    endCard() {
      card.innerHTML = `<div><img class="in" src="${ICON}"><h1 class="in" style="animation-delay:.1s">Tenvy</h1><p class="in" style="animation-delay:.25s">Live TV, guide, catch-up, films and series. One calm app.</p><div class="pill in" style="animation-delay:.45s">Free for Windows</div><div class="url in" style="animation-delay:.6s">quph4.github.io/tenvy-releases</div></div>`
      card.classList.add('on')
      cursor.style.opacity = '0'
    },
    /** Center of the innermost visible element whose text is exactly `text`. */
    byText(text, sel = '*') {
      const all = [...document.querySelectorAll(sel)].filter((e) => e.textContent.trim() === text && visible(e))
      const inner = all.filter((e) => !all.some((o) => o !== e && e.contains(o)))
      const el = inner[0]
      return el ? center(el) : null
    },
    /** The nth upcoming programme on a channel's row in the guide. */
    programme(channel, nth = 1) {
      const label = [...document.querySelectorAll('span, div')].find((e) => e.textContent.trim() === channel && e.children.length === 0 && visible(e))
      if (!label) return null
      const y = center(label).y
      const line = document.querySelector('.bg-red-500\\/70')
      const nowX = line ? line.getBoundingClientRect().left : innerWidth / 2
      const progs = [...document.querySelectorAll('button')]
        .filter((b) => { const r = b.getBoundingClientRect(); return r.top < y && r.bottom > y && r.left > nowX && r.width > 90 && r.right < innerWidth - 20 })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      const el = progs[nth - 1] ?? progs[0]
      return el ? center(el) : null
    },
    /** Smoothly scroll the main scrollable area. */
    scrollMain(dy, ms) {
      const el = [...document.querySelectorAll('main *')]
        .filter((e) => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))
        .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
      if (!el) return false
      const from = el.scrollTop
      const t0 = performance.now()
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms)
        el.scrollTop = from + dy * ease(t)
        if (t < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
      return true
    },
  }
})()
