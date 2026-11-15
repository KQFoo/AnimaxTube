import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { closeDatabase, openDatabase, parseJsonArray } from '../db/index.ts';
import type { ChannelRow } from '../db/schema.ts';

function escapeMd(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function slugAnchor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function generateMarkdown(outputPath = path.resolve(process.cwd(), 'CHANNELS_AND_SERIES.md')): string {
  const db = openDatabase();

  const channels = db
    .prepare(
      `SELECT c.*,
              COUNT(DISTINCT cs.id) AS series_count,
              COALESCE(SUM(cs.episode_count), 0) AS episode_count
       FROM channels c
       LEFT JOIN channel_series cs ON cs.channel_id = c.id
       WHERE c.is_verified = 1
       GROUP BY c.id
       ORDER BY series_count DESC, c.name COLLATE NOCASE ASC`
    )
    .all() as unknown as Array<ChannelRow & { series_count: number; episode_count: number }>;

  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM channels WHERE is_verified = 1) AS ch_cnt,
              (SELECT COUNT(*) FROM series) AS sr_cnt,
              (SELECT COUNT(*) FROM channel_series) AS cs_cnt,
              (SELECT COUNT(*) FROM episodes) AS ep_cnt`
    )
    .get() as { ch_cnt: number; sr_cnt: number; cs_cnt: number; ep_cnt: number };

  const lines: string[] = [];
  lines.push('# Free Anime YouTube Channels & Uploaded Series Directory');
  lines.push('');
  lines.push(`> Auto-generated from \`data/animaxtube.db\` on ${new Date().toISOString().slice(0, 10)}.`);
  lines.push(
    `> Covers **${totals.ch_cnt} verified channels**, **${totals.sr_cnt} grouped 100%-free anime series** (${totals.cs_cnt} channel playlists/series listings), and **${totals.ep_cnt} free episode videos** with English and/or Chinese subtitles (members-only content excluded).`
  );
  lines.push('');

  lines.push('## Summary by Channel');
  lines.push('');
  lines.push('| # | Channel Name | Handle | Languages | Category | Region Focus | Series Uploaded | Episodes |');
  lines.push('|---:|---|---|---|---|---|---:|---:|');

  channels.forEach((ch, idx) => {
    const langs = parseJsonArray(ch.sub_languages).join(', ') || 'en';
    const anchor = slugAnchor(ch.name);
    lines.push(
      `| ${idx + 1} | [${escapeMd(ch.name)}](#${anchor}) | ${escapeMd(ch.handle || ch.youtube_channel_id)} | ${escapeMd(langs)} | ${ch.category} | ${escapeMd(ch.region_focus || 'Global')} | ${ch.series_count} | ${ch.episode_count} |`
    );
  });
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## Channels & Uploaded Anime Series');
  lines.push('');

  const seriesStmt = db.prepare(
    `SELECT cs.playlist_title, cs.playlist_url, cs.sub_language, cs.episode_count, cs.access_note,
            s.canonical_title, s.title_en, s.title_zh
     FROM channel_series cs
     JOIN series s ON s.id = cs.series_id
     WHERE cs.channel_id = ?
     ORDER BY cs.episode_count DESC, s.canonical_title COLLATE NOCASE ASC`
  );

  for (const ch of channels) {
    const langs = parseJsonArray(ch.sub_languages).join(', ') || 'en';
    lines.push(`### ${escapeMd(ch.name)}`);
    lines.push('');
    lines.push(`- **YouTube URL:** ${ch.url}`);
    lines.push(`- **Channel ID:** \`${ch.youtube_channel_id}\``);
    lines.push(`- **Handle:** ${ch.handle || 'N/A'}`);
    lines.push(`- **Subtitle Languages:** ${langs}`);
    lines.push(`- **Region Focus:** ${ch.region_focus || 'Global'}`);
    lines.push(`- **Total Uploaded Series:** ${ch.series_count}`);
    lines.push('');

    const seriesRows = seriesStmt.all(ch.id) as Array<{
      playlist_title: string;
      playlist_url: string;
      sub_language: string;
      episode_count: number;
      access_note: string;
      canonical_title: string;
      title_en: string | null;
      title_zh: string | null;
    }>;

    if (seriesRows.length === 0) {
      lines.push('_No qualifying full-episode anime series playlists found during last sync._');
      lines.push('');
      continue;
    }

    lines.push('| # | Anime Series (Grouped Name) | Original Playlist Title | Sub | Episodes | Playlist |');
    lines.push('|---:|---|---|---|---:|---|');

    seriesRows.forEach((sr, i) => {
      const displayName =
        sr.title_en && sr.title_zh && sr.title_en !== sr.title_zh
          ? `${sr.title_en} / ${sr.title_zh}`
          : sr.canonical_title;
      lines.push(
        `| ${i + 1} | ${escapeMd(displayName)} | ${escapeMd(sr.playlist_title)} | \`${sr.sub_language}\` | ${sr.episode_count} | [Watch Playlist](${sr.playlist_url}) |`
      );
    });
    lines.push('');
  }

  // Cross-channel grouped series appendix
  const multiChannel = db
    .prepare(
      `SELECT s.canonical_title, s.title_en, s.title_zh, s.episode_count,
              GROUP_CONCAT(c.name || ' (' || cs.sub_language || ')', '; ') AS available_on
       FROM series s
       JOIN channel_series cs ON cs.series_id = s.id
       JOIN channels c ON c.id = cs.channel_id
       GROUP BY s.id
       HAVING COUNT(DISTINCT cs.channel_id) > 1
       ORDER BY COUNT(DISTINCT cs.channel_id) DESC, s.canonical_title COLLATE NOCASE ASC`
    )
    .all() as Array<{
    canonical_title: string;
    title_en: string | null;
    title_zh: string | null;
    episode_count: number;
    available_on: string;
  }>;

  if (multiChannel.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Multi-Channel Anime Series (Available Across Multiple Channels)');
    lines.push('');
    lines.push('| Series Name | Max Episodes | Channels & Languages |');
    lines.push('|---|---:|---|');
    for (const m of multiChannel) {
      const label =
        m.title_en && m.title_zh && m.title_en !== m.title_zh
          ? `${m.title_en} / ${m.title_zh}`
          : m.canonical_title;
      lines.push(`| ${escapeMd(label)} | ${m.episode_count} | ${escapeMd(m.available_on)} |`);
    }
    lines.push('');
  }

  const content = lines.join('\n');
  fs.writeFileSync(outputPath, content, 'utf8');
  closeDatabase();
  return outputPath;
}

const isDirect = process.argv[1]?.replace(/\\/g, '/').endsWith('generate-markdown.ts');
if (isDirect) {
  const out = generateMarkdown();
  console.log(`Generated ${out}`);
}
