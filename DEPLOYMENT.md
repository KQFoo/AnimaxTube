# AnimaxTube Deployment Guide (Railway Hobby $5/mo)

This project is preconfigured for **Railway Hobby (`$5/mo`)** with persistent SQLite storage (`/app/data/animaxtube.db`), built-in `/api/health` checks ([`railway.toml`](railway.toml)), automatic live/episode ingestion ([`src/lib/scheduler.ts`](src/lib/scheduler.ts)), and one-time seed bootstrapping ([`src/db/seed.ts`](src/db/seed.ts)).

### Expected Resource Usage on Railway Hobby (`$5/mo` included credit)
- **Memory:** Verified `~83 MB` RSS at runtime (`~$0.85–$1.50/mo` at `$10/GB-mo`).
- **Storage:** `~332 MB` DB + WAL (`< 0.5 GB`, well under Railway Hobby's `5 GB` volume cap, `~$0.07/mo`).
- **Total:** Comfortably inside the flat `$5/mo` Hobby credit for normal traffic. (Set a billing cap in Railway Settings if you want hard spend protection.)

---

## Step 1: Compact & Gzip Your Existing Database Locally

Stop any local dev server first, then run:

```bash
npm run db:compact -- --gzip
```

This folds `animaxtube.db-wal` cleanly into `animaxtube.db` and writes a compressed `data/animaxtube.db.gz` (~110 MB) ready for fast upload on Windows, macOS, or Linux.

---

## Step 2: Deploy on Railway Hobby

1. Push your repository to **GitHub** (`data/` and `.env` are gitignored automatically).
2. In **Railway → New Project → Deploy from GitHub Repo**, select your repo. Railway automatically picks up [`Dockerfile`](Dockerfile) and [`railway.toml`](railway.toml).
3. Add a **Persistent Volume** to the service:
   - **Mount Path:** `/app/data`
4. Open the service **Variables** tab and set:
   ```env
   NODE_ENV=production
   DB_PATH=/app/data/animaxtube.db
   RAILWAY_RUN_UID=0
   YOUTUBE_API_KEY=your_youtube_data_api_v3_key
   PUBLIC_ORIGIN=https://your-service.up.railway.app
   ENABLE_AUTO_SYNC=true
   LIVE_SYNC_INTERVAL_MIN=30
   INCREMENTAL_SYNC_INTERVAL_HOURS=4
   CHANNEL_SYNC_INTERVAL_HOURS=24
   CHANNEL_DISCOVERY_INTERVAL_HOURS=168
   ADMIN_TOKEN=generate_a_long_random_secret_at_least_16_chars
   ```
   > **Important:** `RAILWAY_RUN_UID=0` is required so the container can read and write Railway's root-mounted `/app/data` volume cleanly. `ADMIN_TOKEN` unlocks the stealth `/admin` dashboard (leave unset to keep `/admin` disabled).

---

## Step 3: Seed Your Existing `animaxtube.db` Into `/app/data`

Because Railway Volumes mount empty on first deploy and only attach to one service:

### Option A (Fastest): Automatic Boot Seeding via `SEED_DB_URL`
1. Temporarily upload `animaxtube.db.gz` (or `animaxtube.db`) to a private release asset, Cloudflare R2, S3 presigned URL, or temporary HTTPS file host.
2. Add `SEED_DB_URL=https://.../animaxtube.db.gz` to Railway **Variables** and trigger **Deploy**.
3. On first boot (while `/app/data/animaxtube.db` does not exist yet), [`ensureSeedDatabase`](src/db/seed.ts) streams and gunzips it directly to `/app/data/animaxtube.db`, verifies the SQLite header, and starts serving.
4. Once `https://<your-app>/api/health` shows `series: 3980` / `episodes: 101644`, delete the temporary upload and remove `SEED_DB_URL` from Railway Variables.

### Option B: Direct Upload via Railway CLI (`railway ssh`)
If you already have a URL reachable from SSH:
```bash
railway ssh "curl -L 'https://.../animaxtube.db.gz' | gunzip > /app/data/animaxtube.db"
railway restart
```

---

## Step 4: Verify Live Tracking & Geo Detection

1. Visit `/api/health` — confirm `"ok": true` and full series/episode counts.
2. Visit the homepage — confirm **Live Marathons & Premieres** populates within ~60–90 seconds after startup (triggered by the initial `live-and-unlocks.ts` warmup when `ENABLE_AUTO_SYNC=true`).
3. **(Optional) Custom Domain + Cloudflare Proxy:** Point your domain CNAME to Railway in Cloudflare (Orange Cloud proxied) for `cf-ipcountry` geo-detection headers and edge caching of `/api/*` (`max-age=60`).

---

## Adding New Channels Later

You can add official anime/donghua YouTube channels in three ways:

1. **Private Browser Admin (`/admin`):**
   - Set `ADMIN_TOKEN` (16+ chars) in Railway Variables.
   - Public visitors hitting `/admin` or `/api/admin/*` receive plain `404 Not Found` (completely hidden).
   - Bookmark `https://your-service.up.railway.app/admin?token=YOUR_ADMIN_TOKEN`. Opening it exchanges the token for a signed `HttpOnly` cookie, redirects cleanly to `/admin`, and lets you paste any YouTube URL/`@handle` or approve/reject weekly search candidates (`search_pending`).
2. **CLI (Local or via `railway ssh`):**
   ```bash
   npm run channel:add -- https://www.youtube.com/@SomeOfficialChannel
   ```
3. **Code Registry ([`src/discovery/channel-registry.ts`](src/discovery/channel-registry.ts)):**
   - Append to `SEED_CHANNELS` and deploy; the next scheduled sync (`reconcileMissingSeedChannels`) picks up new registry entries automatically.

---

## Optional: Manual Maintenance Commands via Railway SSH

```bash
# Run an immediate live & unlock refresh
railway ssh "node src/tracking/live-and-unlocks.ts --locked-limit=250"

# Run a single channel sync
railway ssh "node src/ingestion/sync-channels.ts --channel='Ani-One Asia'"

# Refresh viewer comment buzz picks
railway ssh "node src/ingestion/enrich-comments.ts --limit=150"
```
