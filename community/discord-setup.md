# Discord-servern — uppsättning

Texterna att klistra in är på engelska (serverns språk). Stegen är på svenska.

## 1. Inbjudan som aldrig går ut

Länken `discord.gg/bXYCSw2ws` slutar fungera **4 november 2026**. Gör en
permanent:

1. Högerklicka på servern → **Invite People** → **Edit invite link**.
2. **Expire after: Never**, **Max number of uses: No limit** → **Generate a New Link**.
3. Skicka den nya länken till Claude — den byts i `config.json` på en minut
   (appen och webbplatsen följer med, ingen ny version behövs).

## 2. Kanaler

Skapa kategorin **TENVY** med de här kanalerna (ta bort Discords
standardkanaler om du vill):

| Kanal | Typ | Vem skriver | Ämne (Channel topic) |
|---|---|---|---|
| `#welcome` | Text | Bara du | Start here: what Tenvy is and the rules. |
| `#announcements` | Announcement | Bara du | New versions and news. |
| `#help` | Forum (eller text) | Alla | Something not working? Ask here — include your Tenvy version. |
| `#bug-reports` | Forum (eller text) | Alla | One bug per post. Steps, what you expected, and "Copy diagnostics" from Settings → About. |
| `#feature-requests` | Forum (eller text) | Alla | Ideas for Tenvy. One idea per post; react 👍 to vote. |
| `#general` | Text | Alla | Chat about Tenvy and watching TV on a PC. |

"Bara du": kanalinställningar → **Permissions** → `@everyone` → **Send
Messages: ✗** (läsa får alla).

Forumkanaler kräver **Community** (Server Settings → Enable Community) — gör
det, det ger också regelskärm för nya medlemmar.

## 3. Skydd mot säljare och länkdelning

IPTV-servrar drar till sig folk som säljer abonnemang. Server Settings →
**Safety Setup** / **AutoMod**:

- **Block Custom Words** (regel "No selling or sharing streams"), åtgärd
  *Block message* + *Send alert* till dig. Ord att börja med:
  `m3u link`, `free trial`, `reseller`, `restream`, `panel credits`,
  `dm me for`, `cheap iptv`, `iptv subscription`, `get.php`, `player_api`
- **Block Mention Spam** och **Block Spam Content**: på.
- **Verification Level**: *Medium* (kontot måste vara minst 5 minuter gammalt
  och ha verifierad e-post).

## 4. Regler (klistra in i `#welcome`, och under Server Settings → Rules Screening)

```
**Rules**

1. **No providers, no links, no selling.** Don't post, ask for or DM playlists, logins, stream links or provider names/offers. Tenvy is a player only and this server is about the app. Posts like that are removed and repeat posters are banned.
2. **Be kind.** Everyone here is a viewer like you. No harassment, slurs or personal attacks.
3. **Keep your logins private.** Never post your server address, username or password — not even in screenshots. "Copy diagnostics" in Tenvy removes them for you.
4. **Right channel, one topic per post.** Problems in #help or #bug-reports, ideas in #feature-requests.
5. **No piracy talk.** Use Tenvy only with services you have the right to watch.
```

## 5. Välkomsttext (klistra in i `#welcome`, ovanför reglerna)

```
**Welcome to Tenvy** 👋

Tenvy is a free Windows player for the IPTV service you already have — live TV with a full guide, catch-up, films and series. No ads, no account.

⬇️ **Download:** https://quph4.github.io/tenvy-releases/
❓ **Need help?** Post in #help with your Tenvy version (bottom-right corner of the app).
🐞 **Found a bug?** #bug-reports — Settings → About → *Copy diagnostics* and paste it in (logins are removed automatically).
💡 **Have an idea?** #feature-requests — and 👍 the ones you want most.
📣 New versions are posted in #announcements.

Tenvy is made by one developer. If you enjoy it, you can support it at https://ko-fi.com/tenvy96627 — entirely optional.
```

## 6. Första inlägget (klistra in i `#announcements`)

```
**Tenvy 0.1.3 is out** 🎉

What's new:
• **Next episode** starts by itself when an episode ends (10-second countdown — Enter to play now, Esc to cancel)
• **Guide times** can be moved earlier or later, for guides that run an hour off (Settings → Guide)
• **Lock by keyword**: any category or title containing a word you choose needs the parental PIN — including new ones from your provider
• **Backup**: save providers, favorites, progress and settings to one file and restore them on another PC (Settings → Backup)
• Settings now scroll all the way down on smaller screens

Tenvy updates itself — or click the version number in the bottom-right corner to check now.
Download: https://quph4.github.io/tenvy-releases/
```

## 7. Efteråt

- Svara i `#help` och `#bug-reports` så ofta du kan, särskilt första veckorna.
- Klistra in rapporter här till Claude när något behöver rättas.
- Nya versioner: be Claude skriva inlägget till `#announcements` utifrån
  CHANGELOG när en version släpps.
