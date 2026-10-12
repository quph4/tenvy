"""Search landing pages and guides for the website (quph4/tenvy-releases).

    python scripts/site/pages.py <path to a clone of tenvy-releases>

Writes one HTML page per entry in PAGES plus sitemap.xml (submit it in
Google Search Console; a robots.txt would have to live at the domain root,
which a GitHub project site doesn't own).
The pages answer what people search for ("TiviMate for Windows", "M3U
player", "EPG not loading", ...) and lead to the Store / installer. Keep
them honest: what Tenvy does today, and what it doesn't.
"""

import html
import json
import sys
from pathlib import Path

SITE = 'https://quph4.github.io/tenvy-releases/'
STORE = 'https://apps.microsoft.com/detail/9PMCC6XN52D2?mode=direct'
INSTALLER = 'https://github.com/quph4/tenvy-releases/releases/latest'
DISCORD = 'https://discord.gg/WxShS8pgzR'
UPDATED = '12 October 2026'

# ---------------------------------------------------------------- content

# Each page: slug, <title>, meta description, h1, lede, image, body (HTML),
# faq [(question, answer html)].
PAGES = [
    dict(
        slug='tivimate-for-windows',
        title='TiviMate for Windows? A free alternative for your PC – Tenvy',
        description='TiviMate only runs on Android. Tenvy is a free IPTV player made for Windows, with a TiviMate-style TV guide, catch-up, favorites, channel numbers and a mini player.',
        h1='Looking for TiviMate on Windows?',
        lede='TiviMate is one of the best IPTV players for Android TV, but there is no Windows version. Tenvy is a free player built for the PC that works the way TiviMate fans expect: a real TV guide, channel numbers and fast zapping.',
        image=('guide.webp', 'Tenvy\'s TV guide on Windows'),
        body='''
<h2>Why not just run TiviMate in an emulator?</h2>
<p>You can try running TiviMate in an Android emulator like BlueStacks, but it was made for TV remotes, not a mouse and keyboard, and many people find it slow or unreliable that way. A native Windows app is simply nicer to use on a PC.</p>

<h2>What Tenvy has that TiviMate users look for</h2>
<ul>
  <li><b>A full TV guide</b> — every channel on a timeline, with search, reminders and day-by-day browsing.</li>
  <li><b>Catch-up</b> — watch programmes that already aired, straight from the guide, on channels your provider archives.</li>
  <li><b>Channel numbers and zapping</b> — type a number, or use the arrow keys, just like a TV.</li>
  <li><b>Favorites</b> in your own order, and hidden channels and categories you never watch.</li>
  <li><b>Films and series</b> with posters, resume and auto-play of the next episode.</li>
  <li><b>Mini player</b> that stays on top while you work.</li>
  <li><b>Parental PIN</b>, including locks by keyword.</li>
</ul>

<h2>What it doesn't do (yet)</h2>
<p>Tenvy doesn't record yet, and it only runs on Windows. If recording matters to you, tell us on <a href="{DISCORD}">Discord</a> — what users ask for is what gets built next.</p>

<h2>Use the same login as in TiviMate</h2>
<p>Tenvy works with the same details you use in TiviMate: an <b>Xtream Codes</b> login (server, username and password) or an <b>M3U playlist</b> link. Paste it on Tenvy's first screen and your channels, guide, films and series load by themselves.</p>
''',
        faq=[
            ('Is Tenvy free?', 'Yes. No ads, no account, no paid version. If you like it you can support it with a tip, but it\'s entirely optional.'),
            ('Does Tenvy include channels?', 'No. Like TiviMate, Tenvy is a player only. You need your own IPTV subscription, and should only use services you have the right to watch.'),
            ('Can I move my TiviMate favorites over?', 'Not automatically — TiviMate keeps them on your Android device. Adding favorites in Tenvy takes a right-click per channel.'),
        ],
    ),
    dict(
        slug='iptv-smarters-alternative',
        title='IPTV Smarters alternative for Windows – Tenvy, free',
        description='A free alternative to IPTV Smarters for Windows. Use the same Xtream Codes login or M3U link and get a full TV guide, catch-up, films and series in an app made for the PC.',
        h1='An IPTV Smarters alternative for Windows',
        lede='Use IPTV Smarters on your phone or TV, but want something made for the PC? Tenvy is a free Windows IPTV player that takes the same login and gives you a full TV guide, catch-up, films and series.',
        image=('home.webp', 'Tenvy\'s home screen'),
        body='''
<h2>Same login, nothing to set up again</h2>
<p>IPTV Smarters and Tenvy use the same kind of login. Copy the <b>server address, username and password</b> (Xtream Codes) from Smarters or from your provider's email, or use your <b>M3U link</b>. Tenvy loads your channels, categories, guide, films and series from it.</p>

<h2>Made for a PC</h2>
<ul>
  <li><b>Keyboard first</b> — channel numbers, arrow keys to zap, <kbd>Ctrl</kbd>+<kbd>K</kbd> to search everything, <kbd>F</kbd> for fullscreen.</li>
  <li><b>A real guide grid</b> with catch-up, reminders and search.</li>
  <li><b>Mini player</b> in a small always-on-top window.</li>
  <li><b>Light on resources</b> — playback through mpv, not a browser.</li>
  <li><b>Reconnects by itself</b> when a stream drops, and tells you clearly when your subscription has expired or all your connections are in use.</li>
</ul>

<h2>Free, with no catch</h2>
<p>No ads, no account, no tracking and no paid tier. Tenvy is updated regularly, and what people ask for on <a href="{DISCORD}">Discord</a> decides what comes next.</p>
''',
        faq=[
            ('Can I use Tenvy and IPTV Smarters at the same time?', 'Yes, but many providers only allow one stream at a time per login. Tenvy tells you when all your connections are in use.'),
            ('Does Tenvy work with my provider?', 'If your provider gives you an Xtream Codes login or an M3U link, yes. Tenvy doesn\'t include or sell any channels.'),
        ],
    ),
    dict(
        slug='m3u-player-windows',
        title='M3U player for Windows with a TV guide – Tenvy, free',
        description='Play M3U and M3U8 IPTV playlists on Windows with a full TV guide (EPG), catch-up, favorites and channel numbers. Free, no ads, no account.',
        h1='An M3U player for Windows, with a real TV guide',
        lede='VLC can open an M3U playlist, but it gives you a long list and nothing else. Tenvy turns the same playlist into live TV with categories, a programme guide, favorites and channel numbers.',
        image=('guide.webp', 'An M3U playlist with its guide in Tenvy'),
        body='''
<h2>How to play an M3U playlist</h2>
<ol>
  <li>Install Tenvy from the <a href="{STORE}">Microsoft Store</a> (or the <a href="{INSTALLER}">installer</a>).</li>
  <li>Paste your playlist link (<code>http://…/playlist.m3u</code> or <code>.m3u8</code>) on the first screen. A path to a <code>.m3u</code> file on your PC works too.</li>
  <li>Your channels appear grouped by category. Pick one and you're watching.</li>
</ol>

<h2>The guide comes along</h2>
<p>Most playlists name their guide in the first line (<code>url-tvg="…"</code>); Tenvy loads it in the background. If yours doesn't, add the guide's XMLTV link under Settings → Add → XMLTV guide. Channels are matched to the guide by their <code>tvg-id</code>, and by name when that's missing.</p>

<h2>Got an Xtream link?</h2>
<p>If your M3U link looks like <code>…/get.php?username=…&amp;password=…</code>, it comes from an Xtream Codes panel. Tenvy notices and switches to the panel's own login automatically, which adds series with seasons, film posters, catch-up and account details.</p>

<h2>More than a playlist</h2>
<ul>
  <li>Favorites in your own order, hidden channels and categories</li>
  <li>Channel numbers and zapping with the keyboard</li>
  <li>Audio and subtitle tracks, picture shape, sleep timer</li>
  <li>Reconnects by itself when a stream drops</li>
</ul>
''',
        faq=[
            ('Does Tenvy support M3U8?', 'Yes, M3U and M3U8 playlists, including HLS streams.'),
            ('Is there a channel limit?', 'No. Playlists with tens of thousands of channels, films and episodes load fine.'),
            ('Does Tenvy come with a playlist?', 'No. Tenvy is a player only; you use a playlist from a service you have the right to watch.'),
        ],
    ),
    dict(
        slug='xtream-codes-player',
        title='Xtream Codes player for PC (Windows) – Tenvy, free',
        description='A free Xtream Codes player for Windows: log in with server, username and password and get live TV with a guide, catch-up, films and series with posters, and your subscription details.',
        h1='An Xtream Codes player for your PC',
        lede='An Xtream Codes login (server, username, password) is the richest way to watch IPTV: it brings categories, the guide, catch-up, films and series. Tenvy is a free Windows player that uses all of it.',
        image=('movies.webp', 'Films from an Xtream Codes login in Tenvy'),
        body='''
<h2>What you need</h2>
<p>The three details from your provider: the <b>server address</b> (for example <code>http://example.com:8080</code>), your <b>username</b> and your <b>password</b>. Paste them on Tenvy's first screen. Already have a <code>get.php</code> M3U link? Paste that instead — it contains the same login and Tenvy uses it the same way.</p>

<h2>What you get</h2>
<ul>
  <li><b>Live TV</b> in your provider's categories, with channel numbers.</li>
  <li><b>The provider's guide</b>, loaded in the background, with catch-up on channels that have an archive.</li>
  <li><b>Films and series</b> with posters, plots, ratings, seasons and resume.</li>
  <li><b>Account details</b> — when your subscription ends and how many connections you have, with a heads-up before it expires.</li>
  <li><b>Clear errors</b> — "subscription expired" or "all connections in use" instead of a black screen.</li>
</ul>

<h2>Several providers</h2>
<p>Add as many logins as you like and switch between them. Each keeps its own favorites, hidden categories and history.</p>
''',
        faq=[
            ('Is my login safe?', 'Your login is stored only on your PC and sent only to your own provider. Tenvy has no accounts or servers that see it.'),
            ('Why does a channel say all connections are in use?', 'Your provider limits how many streams can play at once on your login. Stop playback on your other devices, or ask your provider for more connections.'),
        ],
    ),
    dict(
        slug='guides/epg-not-loading',
        title='IPTV guide (EPG) not loading on Windows? Here\'s why – Tenvy',
        description='Why the IPTV programme guide (EPG) stays empty in Windows players, and how to fix it: guide size, tvg-id matching, missing url-tvg, Xtream logins and time offsets.',
        h1='IPTV guide (EPG) not loading? Here\'s why',
        lede='The guide grid appears, but the programme info never does. It\'s one of the most common IPTV problems on Windows, and it almost always comes down to one of these five things.',
        image=('guide.webp', 'A working IPTV guide'),
        body='''
<h2>1. The guide file is huge</h2>
<p>A provider's XMLTV guide is often 50–200 MB, usually gzipped. Players that download it in the foreground, or give up after 30 seconds, never finish. Give it a few minutes the first time, and prefer a player that loads the guide in the background.</p>

<h2>2. Channels don't match the guide</h2>
<p>The guide is linked to channels by their <code>tvg-id</code>. Many playlists leave it empty, or spell it differently than the guide (<code>SVT1.se</code> vs <code>svt1.se</code>). A good player also matches on the channel's <i>name</i> — otherwise those channels stay blank.</p>

<h2>3. The playlist doesn't say where the guide is</h2>
<p>An M3U playlist names its guide in the first line: <code>#EXTM3U url-tvg="…"</code>. If that's missing, the player has nothing to load. Ask your provider for the XMLTV (EPG) link and add it separately.</p>

<h2>4. You're using an M3U link instead of the Xtream login</h2>
<p>If your provider gave you a server, username and password (Xtream Codes), use those. The guide then comes from the panel itself and works much more reliably than through an M3U link.</p>

<h2>5. The guide is an hour off</h2>
<p>Some guides are published in the wrong time zone. If programmes consistently start an hour early or late, it's the data, not your clock. Look for a "guide time offset" setting.</p>

<h2>How Tenvy handles it</h2>
<p>Tenvy loads the guide in the background, matches channels by <code>tvg-id</code> or name, switches <code>get.php</code> links to the Xtream login automatically, and has a guide time adjustment from −6 to +6 hours (Settings → Guide).</p>
''',
        faq=[
            ('How long should the guide take to load?', 'Usually under a minute or two, depending on its size and your connection. After that it updates in the background.'),
            ('Some channels have a guide and some don\'t. Why?', 'Those channels aren\'t in the guide file, or their names and ids don\'t match it. Your provider can fix the playlist; there\'s little a player can do about missing data.'),
        ],
    ),
    dict(
        slug='guides/iptv-buffering',
        title='IPTV buffering or freezing on PC? How to find the cause – Tenvy',
        description='Why IPTV streams buffer, freeze or drop on Windows, and how to find out whether it\'s the stream, your provider, your network or your PC.',
        h1='IPTV buffering or freezing on your PC?',
        lede='Buffering has many causes, and the fix depends on which one it is. Test one thing at a time and you\'ll usually find it in a few minutes.',
        image=('home.webp', 'Tenvy'),
        body='''
<h2>1. Is it one channel or all of them?</h2>
<p>If only one channel buffers, the problem is that stream at the provider. Try another channel; if that's fine, report the channel to your provider.</p>

<h2>2. Is it only at busy times?</h2>
<p>Buffering during big football matches or in the evening usually means your provider's servers are overloaded. There's nothing to fix on your side — it passes when the peak does.</p>

<h2>3. Too many connections at once</h2>
<p>Most subscriptions allow one or two streams at a time. If the app is also open on your TV or phone, streams get cut off or refuse to start. Close it elsewhere.</p>

<h2>4. Wi-Fi</h2>
<p>Live TV needs a steady connection, especially in HD and 4K. If you can, try a network cable for a minute — if the buffering stops, it's your Wi-Fi.</p>

<h2>5. Your internet provider</h2>
<p>Some internet providers slow down streaming traffic. If everything else checks out and buffering happens on every channel, at every time of day, a VPN can tell you: if it's smooth through the VPN, your internet provider is the cause.</p>

<h2>How Tenvy helps</h2>
<p>When a stream drops or stalls, Tenvy reconnects by itself with growing pauses and shows the attempts on screen (1/5, 2/5…), so a short hiccup doesn't end your film. It also tells you plainly when your subscription has expired or all your connections are in use, instead of just showing a black screen.</p>
''',
        faq=[
            ('Will a different player fix buffering?', 'Only if the player was the problem — for example one that gives up instead of reconnecting. Most buffering comes from the stream, the provider or the network.'),
        ],
    ),
]

# ---------------------------------------------------------------- template

STYLE = '''
  :root { --bg: #0a0a0a; --panel: #151515; --text: #f5f5f5; --muted: #a3a3a3; --faint: #737373; --gold: #d4b47c; --gold-hi: #e6cfa2; --line: #262626; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.7 Inter, system-ui, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; }
  a { color: var(--gold); }
  header { border-bottom: 1px solid rgba(255,255,255,.05); }
  header .wrap { display: flex; align-items: center; height: 64px; gap: 16px; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 18px; color: var(--text); text-decoration: none; }
  .brand img { width: 30px; height: 30px; border-radius: 8px; }
  .wrap { max-width: 780px; margin: 0 auto; padding: 0 20px; }
  main { padding: 56px 0 88px; }
  h1 { font-size: clamp(32px, 5.5vw, 48px); line-height: 1.08; letter-spacing: -0.03em; margin: 0; }
  .lede { font-size: 19px; color: #d4d4d4; margin: 18px 0 0; }
  .updated { color: var(--faint); font-size: 14px; margin-top: 12px; }
  .shot { margin: 36px 0 8px; border-radius: 14px; border: 1px solid var(--line); overflow: hidden; background: #000; }
  .shot img { display: block; width: 100%; height: auto; }
  h2 { font-size: 22px; margin: 44px 0 6px; letter-spacing: -0.015em; }
  p, li { color: #d4d4d4; }
  li { margin: 6px 0; }
  code, kbd { font-size: 14px; background: #181818; border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; color: #e5e5e5; word-break: break-word; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 46px; padding: 0 20px; border-radius: 11px; font-weight: 600; font-size: 15px; text-decoration: none; }
  .btn-gold { background: var(--gold); color: #0a0a0a; }
  .btn-gold:hover { background: var(--gold-hi); }
  .btn-ghost { border: 1px solid #333; color: var(--text); }
  .btn-sm { height: 36px; padding: 0 14px; font-size: 14px; border-radius: 9px; margin-left: auto; }
  .cta { margin: 48px 0 0; padding: 26px; border-radius: 16px; background: var(--panel); border: 1px solid rgba(212,180,124,.22); }
  .cta h2 { margin: 0 0 6px; }
  .cta p { margin: 0 0 18px; }
  .cta .row { display: flex; flex-wrap: wrap; gap: 10px; }
  details { border-top: 1px solid var(--line); padding: 14px 0; }
  details:last-of-type { border-bottom: 1px solid var(--line); }
  summary { cursor: pointer; font-weight: 600; }
  details p { margin: 8px 0 0; }
  .more { margin-top: 48px; }
  .more ul { padding-left: 20px; }
  footer { border-top: 1px solid #1a1a1a; padding: 32px 0 48px; color: var(--faint); font-size: 14px; }
  footer nav { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-bottom: 12px; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--text); }
'''

LINK_TITLES = {
    'tivimate-for-windows': 'TiviMate for Windows? A free alternative',
    'iptv-smarters-alternative': 'IPTV Smarters alternative for Windows',
    'm3u-player-windows': 'M3U player for Windows',
    'xtream-codes-player': 'Xtream Codes player for PC',
    'guides/epg-not-loading': 'IPTV guide (EPG) not loading?',
    'guides/iptv-buffering': 'IPTV buffering or freezing?',
}


def page(p: dict) -> str:
    depth = p['slug'].count('/')
    up = '../' * depth  # relative path back to the site root
    home = up or './'
    url = SITE + p['slug'] + '.html'
    body = p['body'].replace('{STORE}', STORE).replace('{INSTALLER}', INSTALLER).replace('{DISCORD}', DISCORD)
    faq = ''.join(
        f'<details><summary>{html.escape(q)}</summary><p>{a}</p></details>' for q, a in p['faq']
    )
    others = ''.join(
        f'<li><a href="{up}{slug}.html">{html.escape(title)}</a></li>'
        for slug, title in LINK_TITLES.items()
        if slug != p['slug']
    )
    img, alt = p['image']
    # Structured data: the FAQ, so search results can show the answers.
    faq_ld = json.dumps({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        'mainEntity': [
            {'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': html.unescape(a)}}
            for q, a in p['faq']
        ],
    }, ensure_ascii=False)
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(p['title'])}</title>
<meta name="description" content="{html.escape(p['description'])}">
<link rel="canonical" href="{url}">
<meta property="og:title" content="{html.escape(p['title'])}">
<meta property="og:description" content="{html.escape(p['description'])}">
<meta property="og:image" content="{SITE}assets/og.png">
<meta property="og:url" content="{url}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="{up}assets/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<script type="application/ld+json">{faq_ld}</script>
<style>{STYLE}</style>
</head>
<body>
<header><div class="wrap"><a class="brand" href="{home}"><img src="{up}assets/icon.svg" alt="">Tenvy</a><a class="btn btn-gold btn-sm" href="{STORE}">Get Tenvy</a></div></header>
<main>
  <div class="wrap">
    <h1>{html.escape(p['h1'])}</h1>
    <p class="lede">{html.escape(p['lede'])}</p>
    <div class="updated">Updated {UPDATED}</div>
    <div class="shot"><img src="{up}assets/{img}" alt="{html.escape(alt)}" width="2880" height="1800"></div>
{body}
    <div class="cta">
      <h2>Try Tenvy — it's free</h2>
      <p>No ads, no account. Windows 10 and 11.</p>
      <div class="row">
        <a class="btn btn-gold" href="{STORE}">Get it from Microsoft Store</a>
        <a class="btn btn-ghost" href="{INSTALLER}">Download installer</a>
      </div>
    </div>

    <h2>Questions</h2>
    {faq}

    <div class="more">
      <h2>More</h2>
      <ul>{others}</ul>
    </div>
  </div>
</main>
<footer><div class="wrap">
  <nav><a href="{home}">Tenvy</a><a href="{home}#faq">FAQ</a><a href="{up}privacy.html">Privacy</a><a href="{DISCORD}">Discord</a></nav>
  Tenvy is a media player and does not provide any content. Use it only with services and streams you have the right to watch.
</div></footer>
</body>
</html>
'''


def main():
    root = Path(sys.argv[1])
    urls = [SITE, SITE + 'privacy.html']
    for p in PAGES:
        out = root / (p['slug'] + '.html')
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(page(p), encoding='utf-8')
        urls.append(SITE + p['slug'] + '.html')
        print('wrote', out)
    (root / 'sitemap.xml').write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + ''.join(f'  <url><loc>{u}</loc></url>\n' for u in urls)
        + '</urlset>\n',
        encoding='utf-8',
    )
    print('wrote sitemap.xml')


if __name__ == '__main__':
    main()
