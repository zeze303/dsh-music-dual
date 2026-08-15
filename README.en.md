# dsh-music-dual 🎵

**A dual-platform music player plugin for DeepSeek Harness: NetEase Cloud Music + QQ Music.**

A floating frosted-glass player extended from [dsh-MusicPlayer](https://github.com/xiekai886/dsh-MusicPlayer), keeping all NetEase capabilities and adding QQ Music support: search (zzc signature), playlist import, vkey stream resolution, and login-state unlocks. Collapsible/expandable draggable floating card, host-side state machine + REST routes + agent `music` tool, zero external front-end dependencies.

## Features

- **Floating player**: dark frosted-glass card in the bottom-right corner, **draggable with saved position**, physics-curve expand/collapse animation; play/pause, prev/next, draggable progress bar, volume, list/single/shuffle loop modes, playlist view
- **Dual-platform integration**:
  - **NetEase Cloud Music**: search, playlist import, layered stream resolution — prefers the `NeteaseCloudMusicApi` package (cloudsearch / song_url_v1 / playlist_track_all / login_status), falls back to the anonymous web API + Meting + outer-link when the package is absent
  - **QQ Music**: search (Android `musics.fcg` + `zzc` SHA1 scramble signature, signature-free smartbox fallback), playlist import (`fcg_ucc_getcdinfo_byids_cp`), stream URL (`musicu.fcg` → `vkey.GetVkeyServer/CgiGetVkey`, sip+purl join), login verification (`fcg_get_profile_homepage`)
- **8KB Range probe verification**: both platforms verify every resolved stream URL by fetching its first 8KB (status + content-type + audio magic) before trusting it, avoiding dead 404/HTML endpoints
- **Login-state unlocks**: NetEase `DSH_MUSIC_COOKIE` (MUSIC_U), QQ Music `DSH_MUSIC_QQ_COOKIE` (uin + qm_keyst) — configured cookies unlock full audio for entitled member/VIP tracks
- **Agent `music` tool**: tell the model "play a song / load my playlist / search QQ Music" — the tool accepts a `platform` parameter for dual-platform search/import/playback
- **State sync**: browser player and host state machine sync over REST (`/dsh-music/state` polling + `/dsh-music/command` control); no persistence by design
- **Zero external front-end deps**: hand-written `__ModuleLoader__` format with inline SVG icons, no CDN

## Install

Requires the [DSH CLI](https://github.com/deepseek-ai/deepseek-harness) and pnpm:

```sh
# Install from GitHub
dsh plugin --profile web add "github:zeze303/dsh-music-dual"
# Or install from local source (development)
dsh plugin --profile web add "file:/path/to/dsh-music-dual"
```

Restart `dsh web` (`dsh --profile web`) and the 🎵 player appears in the bottom-right corner.

> Note: NetEase signed endpoints depend on the `NeteaseCloudMusicApi` npm package (installed automatically as a dependency). When the package is missing the plugin falls back to the anonymous API — basic functionality still works.

## Configuration

### Default playlist (NetEase)

```sh
# e.g. set the default library to playlist 13060319975
set DSH_MUSIC_PLAYLIST=13060319975
dsh --profile web
```

Without a configured playlist the queue starts empty; import playlists manually via the player 🔍 panel.

### Login-state unlocks (optional)

```sh
# NetEase: copy MUSIC_U=... (plus necessary cookies) from a logged-in browser session
set DSH_MUSIC_COOKIE=MUSIC_U=xxxx;__csrf=xxxx

# QQ Music: copy uin=...; qm_keyst=... from a logged-in y.qq.com session
# IMPORTANT: qm_keyst (or qqmusic_key/music_key) playback ticket is required —
# a plain "web login state" of uin + qqmusic_key cannot exchange full stream URLs
set DSH_MUSIC_QQ_COOKIE=uin=123456789;qm_keyst=xxxx
dsh --profile web
```

With cookies configured the plugin resolves playable URLs under that login (full audio for entitled tracks). Cookies stay in your local environment variables and are never uploaded to third parties. Without cookies the plugin falls back to anonymous resolution (free tracks only).

> ⚠️ For personal use only; entitlements follow what each platform actually returns. For VIP/copyright-restricted tracks without login: NetEase returns cover-version alternatives or trial clips, QQ Music returns error code `104003`.

## Usage

- Click the 🎵 card to expand; drag anywhere on the header to move (position remembered); click the arrow in the top-right to expand/collapse (animated)
- Click 🔍 to open the search panel: switch **NetEase / QQ Music** with the top tabs, type a title/artist and press Enter to search, click + to add to the queue
- Paste a playlist link or id of the current platform into the first input and press Enter to import (replaces the current library)
- In chat, just say "play a song / play Jay Chou's Sunny Day / search QQ Music / load my playlist / next / pause / shuffle / volume to 50%" — the agent drives the `music` tool

## agent `music` tool

| action | description |
|---|---|
| `play` | play; `query` matches the local queue first, then searches the chosen platform and enqueues |
| `search` | search songs (`platform`: netease/qq) |
| `playlist` | import playlist (`platform` + `id`/`url`) |
| `pause` / `next` / `prev` / `list` | playback control & queue view |
| `add` / `remove` | add a direct link / remove by index |
| `volume` / `mode` | volume 0-1 / loop mode list·single·shuffle |
| `builtin` / `reset` | restore/hide default playlist / reset |

## REST API

| endpoint | description |
|---|---|
| `GET /dsh-music/state` | player state snapshot |
| `POST /dsh-music/command` | player intent (`importPlaylist` accepts `platform`) |
| `GET /dsh-music/netease/{search,playlist,stream,login}` | NetEase search/playlist/audio proxy/login |
| `GET /dsh-music/qq/{search,playlist,stream,login}` | QQ Music search/playlist/audio proxy/login |

## Structure

- `index.js` — host half: state machine, REST routes, `music` tool, dual-platform resolvers (NeteaseCloudMusicApi-first with fallback, QQ zzc signature/vkey), 8KB probing
- `client.js` — browser half: floating player (`__ModuleLoader__` format, platform switch, zero external deps)
- `cordis.patch.yml` — bundle layer manifest
- `package.json` — package metadata (depends on `NeteaseCloudMusicApi`)

## Disclaimer

- This project is not affiliated with DeepSeek, NetEase Cloud Music, or QQ Music/Tencent Music Entertainment Group; audio comes from the platforms' public endpoints and third-party resolvers, for learning and personal use only
- Copyright/VIP-restricted tracks may not play
- All `music` tool and UI operations happen inside your local DSH instance
- Extended from [dsh-MusicPlayer](https://github.com/xiekai886/dsh-MusicPlayer) (MIT); QQ Music integration follows the open-source approach of the [Mineradio](https://github.com/xiaoyangcheng84-svg/dsh-skin-manager) project

## License

[MIT](LICENSE)
