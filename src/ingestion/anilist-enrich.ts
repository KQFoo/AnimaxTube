import 'dotenv/config';
import { openDatabase, closeDatabase, refreshSeriesStats } from '../db/index.ts';
import type { SeriesRow } from '../db/schema.ts';

const ANILIST_URL = process.env.ANILIST_API_URL || 'https://graphql.anilist.co';

const SEARCH_QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 3) {
    media(search: $search, type: ANIME, sort: POPULARITY_DESC) {
      id
      title {
        romaji
        english
        native
      }
      coverImage {
        extraLarge
        large
      }
      bannerImage
      description(asHtml: false)
      genres
      seasonYear
      synonyms
    }
  }
}`;

interface AniListMedia {
  id: number;
  title: { romaji?: string; english?: string; native?: string };
  coverImage?: { extraLarge?: string; large?: string };
  bannerImage?: string;
  description?: string;
  genres?: string[];
  seasonYear?: number;
  synonyms?: string[];
}

async function queryAniList(search: string): Promise<AniListMedia | null> {
  const res = await fetch(ANILIST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { search } }),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '15', 10);
    await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
    return queryAniList(search);
  }
  if (!res.ok) return null;

  const json = (await res.json()) as { data?: { Page?: { media?: AniListMedia[] } } };
  const list = json.data?.Page?.media || [];
  if (list.length === 0) return null;

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  const target = norm(search);
  for (const m of list) {
    const candidates = [m.title.english, m.title.romaji, m.title.native, ...(m.synonyms || [])].filter(Boolean) as string[];
    if (candidates.some((c) => norm(c) === target || norm(c).includes(target) || target.includes(norm(c)))) {
      return m;
    }
  }
  return list[0];
}

function mergeSeriesIntoTarget(
  db: ReturnType<typeof openDatabase>,
  sourceId: number,
  targetId: number
): void {
  if (sourceId === targetId) return;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE OR IGNORE channel_series SET series_id = ? WHERE series_id = ?').run(targetId, sourceId);
    db.prepare('UPDATE episodes SET series_id = ? WHERE series_id = ?').run(targetId, sourceId);
    db.prepare('DELETE FROM series_fts WHERE series_id = ?').run(sourceId);
    db.prepare('DELETE FROM series WHERE id = ?').run(sourceId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  refreshSeriesStats(db, targetId);
}

export async function runAniListEnrich(limit = 150) {
  const db = openDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM series
       WHERE anilist_id IS NULL
       ORDER BY episode_count DESC
       LIMIT ?`
    )
    .all(limit) as unknown as SeriesRow[];

  console.log(`Enriching up to ${rows.length} series via AniList GraphQL...`);
  let matched = 0;
  let merged = 0;

  for (const row of rows) {
    try {
      const media = await queryAniList(row.canonical_title);
      // Respect AniList ~90 req/min rate limit
      await new Promise((r) => setTimeout(r, 720));
      if (!media) continue;

      const existing = db
        .prepare('SELECT id FROM series WHERE anilist_id = ? LIMIT 1')
        .get(media.id) as { id: number } | undefined;

      if (existing && existing.id !== row.id) {
        // Merge cross-language / cross-channel series sharing the same AniList ID
        if (row.title_zh) {
          db.prepare('UPDATE series SET title_zh = COALESCE(title_zh, ?) WHERE id = ?').run(row.title_zh, existing.id);
        }
        if (row.title_en) {
          db.prepare('UPDATE series SET title_en = COALESCE(title_en, ?) WHERE id = ?').run(row.title_en, existing.id);
        }
        mergeSeriesIntoTarget(db, row.id, existing.id);
        merged++;
        continue;
      }

      const posterUrl = media.coverImage?.extraLarge || media.coverImage?.large || null;
      const synopsis = media.description ? media.description.replace(/\n{3,}/g, '\n\n').trim() : null;
      db.prepare(
        `UPDATE series
         SET anilist_id = ?,
             title_en = COALESCE(title_en, ?),
             title_romaji = COALESCE(title_romaji, ?),
             poster_url = COALESCE(poster_url, ?),
             banner_url = COALESCE(banner_url, ?),
             synopsis = COALESCE(synopsis, ?),
             genres = CASE WHEN genres = '[]' THEN ? ELSE genres END,
             season_year = COALESCE(season_year, ?)
         WHERE id = ?`
      ).run(
        media.id,
        media.title.english || null,
        media.title.romaji || null,
        posterUrl,
        media.bannerImage || null,
        synopsis,
        JSON.stringify(media.genres || []),
        media.seasonYear || null,
        row.id
      );
      refreshSeriesStats(db, row.id);
      matched++;
    } catch (err) {
      console.warn(`  [warn] AniList enrich failed for "${row.canonical_title}":`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`AniList enrichment finished: ${matched} enriched, ${merged} cross-channel series merged.`);
  closeDatabase();
}

const isDirect = process.argv[1]?.replace(/\\/g, '/').endsWith('anilist-enrich.ts');
if (isDirect) {
  const limitArg = process.argv.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) || 150 : 150;
  runAniListEnrich(limit).catch((err) => {
    console.error(err);
    closeDatabase();
    process.exit(1);
  });
}
