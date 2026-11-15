# AnimaxTube

A lightweight, database-backed YouTube web app & PWA dedicated to **free, official anime & donghua series channels** with **English** and **Chinese** subtitles — grouped cleanly by **series name**.

## Features

- **Channel Discovery & Verification (`npm run discover`)**: Resolves official licensors, studios, and donghua channels (Muse Asia, Muse木棉花-TW/HK, Ani-One Asia, Ani-One中文官方動畫頻道, GundamInfo, It's Anime / REMOW, Tropics Anime Asia, TMS Official, MadeByBilibili, Tencent Video Animation, YOUKU Animation, etc.) plus live YouTube search discovery.
- **Full Playlist & Upload Sync (`npm run sync`)**: Scans all series playlists (and unplaylisted episode uploads) per channel, extracts episode numbers and subtitle languages (`en`, `zh-Hant`, `zh-Hans`, `multi`), and stores them in local SQLite (`data/animaxtube.db` via Node.js `node:sqlite`).
- **Cross-Channel Series Grouping (`npm run enrich`)**: Optionally matches series against AniList GraphQL API to unify English and Chinese releases of the same show under one series card with a language/channel switcher in the watch player.
- **Markdown Catalog (`npm run export:md`)**: Exports every channel name and all of its uploaded anime series to [`CHANNELS_AND_SERIES.md`](./CHANNELS_AND_SERIES.md).
- **YouTube-Style Watch UI**: Dark YouTube-inspired PWA with instant FTS5 search (EN / 中文 / Romaji), language & channel filters, YouTube IFrame binge player, auto-next episode queue, theater mode, and local watch history / saved series.

## Quick Start

```bash
npm install
cp .env.example .env   # add your YOUTUBE_API_KEY
npm run discover       # discover & verify free-anime YouTube channels
npm run sync           # fetch all series playlists & episodes into SQLite
npm run enrich         # optional: link EN/ZH releases & fetch posters via AniList
npm run export:md      # generate CHANNELS_AND_SERIES.md
npm run dev            # start server at http://localhost:3000
```

## Tech Stack

- **Runtime**: Node.js 24 (`node:sqlite` + `--experimental-strip-types` test runner)
- **Server**: Hono + `@hono/node-server`
- **Database**: Local SQLite (`WAL` + `FTS5`)
- **Frontend**: Vanilla ES6+ PWA (`public/`) + YouTube IFrame Player API
