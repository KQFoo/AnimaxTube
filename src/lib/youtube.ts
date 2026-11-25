import 'dotenv/config';

const YT_API = 'https://www.googleapis.com/youtube/v3';

export interface YtChannelInfo {
  id: string;
  title: string;
  description: string;
  customUrl: string | null;
  avatarUrl: string | null;
  uploadsPlaylistId: string | null;
  videoCount: number;
}

export interface YtPlaylist {
  id: string;
  title: string;
  description: string;
  itemCount: number;
  thumbnailUrl: string | null;
  publishedAt: string | null;
}

export interface YtPlaylistItem {
  videoId: string;
  title: string;
  description: string;
  position: number;
  thumbnailUrl: string | null;
  publishedAt: string | null;
}

export interface YtVideoDetail {
  id: string;
  title: string;
  description: string;
  publishedAt: string | null;
  durationIso: string | null;
  tags: string[];
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  privacyStatus: string;
  liveBroadcastContent: 'none' | 'live' | 'upcoming';
  concurrentViewers: number;
  actualStartTime: string | null;
  scheduledStartTime: string | null;
  thumbnailUrl: string | null;
  isMembersOnly: boolean;
  embeddable: boolean;
  regionAllowed: string[];
  regionBlocked: string[];
}

export interface YtRssEntry {
  videoId: string;
  title: string;
  publishedAt: string | null;
  description: string;
  thumbnailUrl: string | null;
}

export interface YtCommentItem {
  author: string;
  text: string;
  likeCount: number;
}

export interface YtSearchResult {
  kind: 'video' | 'playlist' | 'channel';
  id: string;
  title: string;
  description: string;
  channelId: string;
  channelTitle: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
}

let activeKeyIndex = 0;

export function resetKeyRotation(): void {
  activeKeyIndex = 0;
}

export function getYouTubeApiKeys(): string[] {
  const raw = [process.env.YOUTUBE_API_KEYS || '', process.env.YOUTUBE_API_KEY || '']
    .join(',')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k && k !== 'your_youtube_data_api_v3_key');
  const unique = [...new Set(raw)];
  if (unique.length === 0) {
    throw new Error('YOUTUBE_API_KEY (or YOUTUBE_API_KEYS) is missing in .env or environment variables.');
  }
  return unique;
}

export function getYouTubeApiKey(): string {
  const keys = getYouTubeApiKeys();
  return keys[activeKeyIndex % keys.length];
}

let sessionQuotaUnits = 0;
let quotaRecorder: ((units: number) => void) | null = null;

export function getSessionQuotaUnits(): number {
  return sessionQuotaUnits;
}

export function setQuotaRecorder(fn: ((units: number) => void) | null): void {
  quotaRecorder = fn;
}

export function getYouTubeQuotaDayKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value || '1970';
  const m = parts.find((p) => p.type === 'month')?.value || '01';
  const d = parts.find((p) => p.type === 'day')?.value || '01';
  return `${y}-${m}-${d}`;
}

export function getNextQuotaResetUnix(now = new Date()): number {
  const currentDay = getYouTubeQuotaDayKey(now);
  // Step forward in 15-minute increments (max 25h) to find exact Pacific midnight across DST
  let lo = Math.floor(now.getTime() / 1000);
  let hi = lo + 25 * 3600;
  while (hi - lo > 60) {
    const mid = Math.floor((lo + hi) / 2);
    if (getYouTubeQuotaDayKey(new Date(mid * 1000)) === currentDay) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

function isQuotaExceededError(status: number, body: string): boolean {
  return status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(body);
}

async function ytFetchJson<T>(buildUrl: (apiKey: string) => string, quotaCost: number, label: string): Promise<T> {
  const keys = getYouTubeApiKeys();
  let keyAttempts = 0;
  let transientDelay = 800;
  let transientAttempts = 0;

  while (true) {
    const key = keys[activeKeyIndex % keys.length];
    const res = await fetch(buildUrl(key));
    sessionQuotaUnits += quotaCost;
    if (quotaRecorder) {
      try {
        quotaRecorder(quotaCost);
      } catch {
        // ignore quota persistence errors
      }
    }
    if (res.ok) {
      return (await res.json()) as T;
    }

    const body = await res.text().catch(() => '');
    if (isQuotaExceededError(res.status, body)) {
      keyAttempts++;
      if (keyAttempts < keys.length) {
        activeKeyIndex = (activeKeyIndex + 1) % keys.length;
        console.warn(`YouTube API quota exceeded on key #${keyAttempts}; rotating to key #${(activeKeyIndex % keys.length) + 1}...`);
        continue;
      }
      throw new Error(`YouTube API ${label} failed (${res.status}): ${body.slice(0, 200)}`);
    }

    transientAttempts++;
    if ((res.status === 429 || res.status >= 500) && transientAttempts < 4) {
      await new Promise((r) => setTimeout(r, transientDelay));
      transientDelay *= 2;
      continue;
    }
    throw new Error(`YouTube API ${label} failed (${res.status}): ${body.slice(0, 200)}`);
  }
}

function mapChannelItem(item: any): YtChannelInfo {
  const thumbs = item.snippet?.thumbnails;
  const avatarUrl = thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || null;
  return {
    id: item.id,
    title: item.snippet?.title || item.id,
    description: item.snippet?.description || '',
    customUrl: item.snippet?.customUrl || null,
    avatarUrl,
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || null,
    videoCount: parseInt(item.statistics?.videoCount || '0', 10) || 0,
  };
}

export async function fetchChannelByHandle(handle: string): Promise<YtChannelInfo | null> {
  const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`;
  const data = await ytFetchJson<{ items?: any[] }>(
    (key) => `${YT_API}/channels?part=snippet,contentDetails,statistics&forHandle=${encodeURIComponent(cleanHandle)}&key=${key}`,
    1,
    `channels.list(handle=${cleanHandle})`
  );
  if (!data.items || data.items.length === 0) return null;
  return mapChannelItem(data.items[0]);
}

export async function fetchChannelsByIds(channelIds: string[]): Promise<YtChannelInfo[]> {
  const unique = [...new Set(channelIds)].filter(Boolean);
  const results: YtChannelInfo[] = [];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await ytFetchJson<{ items?: any[] }>(
      (key) => `${YT_API}/channels?part=snippet,contentDetails,statistics&id=${chunk.join(',')}&key=${key}`,
      1,
      `channels.list(ids=${chunk.length})`
    );
    for (const item of data.items || []) {
      results.push(mapChannelItem(item));
    }
  }
  return results;
}

export async function searchChannels(
  query: string,
  maxResults = 15
): Promise<Array<{ channelId: string; title: string; description: string }>> {
  const data = await ytFetchJson<{ items?: any[] }>(
    (key) => `${YT_API}/search?part=snippet&type=channel&maxResults=${maxResults}&q=${encodeURIComponent(query)}&key=${key}`,
    100,
    `search.list(${query})`
  );
  return (data.items || [])
    .map((item) => ({
      channelId: item.snippet?.channelId || item.id?.channelId || '',
      title: item.snippet?.title || '',
      description: item.snippet?.description || '',
    }))
    .filter((c) => Boolean(c.channelId));
}

export async function searchYouTube(
  query: string,
  type: 'video' | 'playlist' | 'channel' = 'playlist',
  maxResults = 8
): Promise<YtSearchResult[]> {
  const clamped = Math.min(15, Math.max(1, maxResults));
  const data = await ytFetchJson<{ items?: any[] }>(
    (key) => `${YT_API}/search?part=snippet&type=${type}&maxResults=${clamped}&q=${encodeURIComponent(query)}&key=${key}`,
    100,
    `search.list(${type}:${query})`
  );
  return (data.items || [])
    .map((item) => {
      const id =
        type === 'video'
          ? item.id?.videoId || ''
          : type === 'playlist'
            ? item.id?.playlistId || ''
            : item.id?.channelId || item.snippet?.channelId || '';
      const thumbs = item.snippet?.thumbnails;
      const thumbnailUrl = thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || null;
      return {
        kind: type,
        id,
        title: decodeXml(item.snippet?.title || ''),
        description: decodeXml(item.snippet?.description || ''),
        channelId: item.snippet?.channelId || '',
        channelTitle: decodeXml(item.snippet?.channelTitle || ''),
        thumbnailUrl,
        publishedAt: item.snippet?.publishedAt || null,
      };
    })
    .filter((r) => Boolean(r.id));
}

export async function fetchAllPlaylists(channelId: string, maxPages = 20): Promise<YtPlaylist[]> {
  const playlists: YtPlaylist[] = [];
  let pageToken = '';
  for (let page = 0; page < maxPages; page++) {
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    const data = await ytFetchJson<{ items?: any[]; nextPageToken?: string }>(
      (key) => `${YT_API}/playlists?part=snippet,contentDetails&channelId=${encodeURIComponent(channelId)}&maxResults=50${tokenParam}&key=${key}`,
      1,
      `playlists.list(${channelId} p${page + 1})`
    );
    for (const item of data.items || []) {
      const thumbs = item.snippet?.thumbnails;
      const thumbnailUrl = thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || null;
      playlists.push({
        id: item.id,
        title: item.snippet?.title || '',
        description: item.snippet?.description || '',
        itemCount: item.contentDetails?.itemCount || 0,
        thumbnailUrl,
        publishedAt: item.snippet?.publishedAt || null,
      });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return playlists;
}

export async function fetchPlaylistItems(playlistId: string, maxPages = 10): Promise<YtPlaylistItem[]> {
  const items: YtPlaylistItem[] = [];
  let pageToken = '';
  for (let page = 0; page < maxPages; page++) {
    const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
    let data: { items?: any[]; nextPageToken?: string };
    try {
      data = await ytFetchJson<{ items?: any[]; nextPageToken?: string }>(
        (key) => `${YT_API}/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(playlistId)}&maxResults=50${tokenParam}&key=${key}`,
        1,
        `playlistItems.list(${playlistId} p${page + 1})`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404')) break;
      throw err;
    }
    for (const item of data.items || []) {
      const videoId = item.contentDetails?.videoId || item.snippet?.resourceId?.videoId;
      const title = item.snippet?.title || '';
      if (!videoId || title === 'Deleted video' || title === 'Private video') continue;
      const thumbs = item.snippet?.thumbnails;
      const thumbnailUrl = thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || null;
      items.push({
        videoId,
        title,
        description: item.snippet?.description || '',
        position: typeof item.snippet?.position === 'number' ? item.snippet.position : items.length,
        thumbnailUrl,
        publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null,
      });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return items;
}

/**
 * Fetches rich video metadata in batches of 50 (1 unit per 50 videos).
 * Public videos return statistics.viewCount; members-only/private videos omit it.
 */
export async function fetchVideoDetailsMap(videoIds: string[]): Promise<Map<string, YtVideoDetail>> {
  const unique = [...new Set(videoIds)].filter(Boolean);
  const map = new Map<string, YtVideoDetail>();
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const data = await ytFetchJson<{ items?: any[] }>(
      (key) => `${YT_API}/videos?part=snippet,contentDetails,statistics,status,liveStreamingDetails&id=${chunk.join(',')}&key=${key}`,
      1,
      `videos.list(x${chunk.length})`
    );
    for (const item of data.items || []) {
      const rr = item.contentDetails?.regionRestriction || {};
      const stats = item.statistics || {};
      const status = item.status || {};
      const live = item.liveStreamingDetails || {};
      const thumbs = item.snippet?.thumbnails;
      const viewCount = stats.viewCount !== undefined ? parseInt(stats.viewCount, 10) : null;
      const likeCount = stats.likeCount !== undefined ? parseInt(stats.likeCount, 10) : null;
      const commentCount = stats.commentCount !== undefined ? parseInt(stats.commentCount, 10) : null;
      const privacyStatus = status.privacyStatus || 'public';
      const liveBroadcastContent =
        item.snippet?.liveBroadcastContent === 'live'
          ? 'live'
          : item.snippet?.liveBroadcastContent === 'upcoming'
            ? 'upcoming'
            : 'none';

      // Members-only videos omit statistics.viewCount when queried via public API key
      const isMembersOnly = privacyStatus !== 'public' || (viewCount === null && liveBroadcastContent === 'none');

      map.set(item.id, {
        id: item.id,
        title: item.snippet?.title || '',
        description: item.snippet?.description || '',
        publishedAt: item.snippet?.publishedAt || null,
        durationIso: item.contentDetails?.duration || null,
        tags: Array.isArray(item.snippet?.tags) ? item.snippet.tags : [],
        defaultLanguage: item.snippet?.defaultLanguage || null,
        defaultAudioLanguage: item.snippet?.defaultAudioLanguage || null,
        viewCount: Number.isFinite(viewCount) ? viewCount : null,
        likeCount: Number.isFinite(likeCount) ? likeCount : null,
        commentCount: Number.isFinite(commentCount) ? commentCount : null,
        privacyStatus,
        liveBroadcastContent,
        concurrentViewers: parseInt(live.concurrentViewers || '0', 10) || 0,
        actualStartTime: live.actualStartTime || null,
        scheduledStartTime: live.scheduledStartTime || null,
        thumbnailUrl: thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url || null,
        isMembersOnly,
        embeddable: status.embeddable !== false,
        regionAllowed: Array.isArray(rr.allowed) ? rr.allowed : [],
        regionBlocked: Array.isArray(rr.blocked) ? rr.blocked : [],
      });
    }
  }
  return map;
}

/** Zero-quota YouTube channel RSS feed parser (latest ~15 uploads). */
export async function fetchChannelRssFeed(channelId: string): Promise<YtRssEntry[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'AnimaxTube/1.0' } });
  if (!res.ok) return [];
  const xml = await res.text();
  const entries: YtRssEntry[] = [];
  const entryMatches = xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g);
  for (const m of entryMatches) {
    const block = m[1];
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]?.trim();
    const title = decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const publishedAt = block.match(/<published>([^<]+)<\/published>/)?.[1]?.trim() || null;
    const description = decodeXml(block.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] || '');
    const thumbnailUrl = block.match(/<media:thumbnail[^>]*url="([^"]+)"/)?.[1] || null;
    if (videoId && title) {
      entries.push({ videoId, title, publishedAt, description, thumbnailUrl });
    }
  }
  return entries;
}

/** Zero-quota probe of /channel/<id>/live canonical link to detect active livestreams. */
export async function probeChannelLiveVideoId(channelId: string): Promise<string | null> {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const isLive = /"isLiveNow"\s*:\s*true/i.test(html) || /"liveBroadcastDetails"\s*:\s*\{[^}]*"isLiveNow"\s*:\s*true/i.test(html);
    if (!isLive) return null;
    const canonical = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})"/);
    return canonical?.[1] || null;
  } catch {
    return null;
  }
}

/** Fetch top relevance-sorted comments for Episode 1 (1 quota unit). */
export async function fetchVideoComments(videoId: string, maxResults = 25): Promise<YtCommentItem[]> {
  try {
    const data = await ytFetchJson<{ items?: any[] }>(
      (key) => `${YT_API}/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&order=relevance&maxResults=${maxResults}&textFormat=plainText&key=${key}`,
      1,
      `commentThreads.list(${videoId})`
    );
    return (data.items || [])
      .map((item) => {
        const s = item.snippet?.topLevelComment?.snippet;
        return {
          author: s?.authorDisplayName || 'Viewer',
          text: s?.textDisplay || '',
          likeCount: parseInt(s?.likeCount || '0', 10) || 0,
        };
      })
      .filter((c) => Boolean(c.text));
  } catch {
    return [];
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
