import type { DatabaseSync } from 'node:sqlite';

export const SITE_NAME = 'AnimaxTube';
const DEFAULT_TITLE = SITE_NAME;
const DEFAULT_DESCRIPTION =
  'An index of anime officially published by licensed YouTube channels (Muse Asia, Ani-One Asia, GundamInfo, TMS and more), grouped by series. AnimaxTube hosts no video files; every stream plays through the official YouTube player.';
export interface PageMeta {
  title: string;
  description: string;
  canonicalPath: string;
  ogType: 'website' | 'video.tv_show';
  image?: string | null;
  noindex?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

export function buildWatchMeta(db: DatabaseSync, slug: string): PageMeta | null {
  const row = db
    .prepare(
      `SELECT s.slug, s.canonical_title AS title, s.poster_url, s.synopsis,
              c.name AS channel_name
       FROM series s
       LEFT JOIN channel_series cs ON cs.series_id = s.id
       LEFT JOIN channels c ON c.id = cs.channel_id
       WHERE s.slug = ?
       ORDER BY cs.episode_count DESC
       LIMIT 1`
    )
    .get(slug) as
    | { slug: string; title: string; poster_url: string | null; synopsis: string | null; channel_name: string | null }
    | undefined;
  if (!row) return null;

  const channel = row.channel_name || 'Official Licensee';
  const lead = `Official YouTube playlist for ${row.title}, published by ${channel} (licensed rights holder). Plays via the official YouTube embed; views and ad revenue go to ${channel}. Availability depends on your region.`;
  return {
    title: `${row.title} — Official YouTube Stream Directory (${channel}) | ${SITE_NAME}`,
    description: truncate(row.synopsis ? `${lead} ${row.synopsis}` : lead, 300),
    canonicalPath: `/watch/${encodeURIComponent(row.slug)}`,
    ogType: 'video.tv_show',
    image: row.poster_url,
  };
}

export function buildPageMeta(db: DatabaseSync, pathname: string): PageMeta {
  if (pathname.startsWith('/watch/')) {
    const slug = decodeURIComponent(pathname.slice('/watch/'.length));
    const meta = buildWatchMeta(db, slug);
    if (meta) return meta;
    return {
      title: `Series not found | ${SITE_NAME}`,
      description: DEFAULT_DESCRIPTION,
      canonicalPath: '/',
      ogType: 'website',
      noindex: true,
    };
  }
  if (pathname === '/about' || pathname === '/legal' || pathname === '/dmca') {
    return {
      title: `About, Legal & DMCA | ${SITE_NAME}`,
      description:
        'AnimaxTube hosts no video files. It indexes official, publicly embeddable YouTube playlists from licensed channels. Regional licensing notes, anti-piracy crawler guidance, and DMCA / opt-out contact.',
      canonicalPath: '/about',
      ogType: 'website',
    };
  }
  if (pathname === '/channels') {
    return {
      title: `Official Licensed Anime Channels on YouTube | ${SITE_NAME}`,
      description:
        'Directory of licensed anime distributors that publish full episodes on their official YouTube channels, with their regional focus.',
      canonicalPath: '/channels',
      ogType: 'website',
    };
  }
  if (pathname === '/calendar') {
    return {
      title: `YouTube Anime Release Calendar & Schedule | ${SITE_NAME}`,
      description:
        'Weekly release schedule, live countdowns, and recent episode drops across official licensed anime YouTube channels in your local timezone.',
      canonicalPath: '/calendar',
      ogType: 'website',
    };
  }
  if (pathname === '/songs') {
    return {
      title: `Anime Songs — Official OP, ED & OST on YouTube | ${SITE_NAME}`,
      description:
        'Listen to official anime openings (OP), endings (ED), and soundtracks (OST) published on licensed YouTube channels.',
      canonicalPath: '/songs',
      ogType: 'website',
    };
  }
  return {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    canonicalPath: '/',
    ogType: 'website',
    noindex: pathname === '/watchlist' || pathname === '/history',
  };
}

export function renderIndexHtml(
  template: string,
  meta: PageMeta,
  opts: { origin: string }
): string {
  const safeImage = safeHttpUrl(meta.image);
  const canonical = `${opts.origin}${meta.canonicalPath}`;
  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:type" content="${meta.ogType}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    safeImage ? `<meta property="og:image" content="${escapeHtml(safeImage)}" />` : '',
    `<meta name="twitter:card" content="${safeImage ? 'summary_large_image' : 'summary'}" />`,
    meta.noindex ? '<meta name="robots" content="noindex" />' : '',
  ]
    .filter(Boolean)
    .join('\n  ');

  return template.replace(/<title>[\s\S]*?<\/title>/, tags);
}
