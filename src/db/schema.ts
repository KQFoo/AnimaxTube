export interface ChannelRow {
  id: number;
  youtube_channel_id: string;
  handle: string | null;
  name: string;
  url: string;
  avatar_url: string | null;
  description: string | null;
  uploads_playlist_id: string | null;
  region_focus: string | null;
  sub_languages: string;
  category: 'anime' | 'donghua' | 'studio';
  discovery_source: string;
  is_verified: number;
  playlist_count: number;
  last_synced_at: number | null;
  created_at: number;
}

export interface SeriesRow {
  id: number;
  slug: string;
  canonical_title: string;
  normalized_key: string;
  title_en: string | null;
  title_zh: string | null;
  title_romaji: string | null;
  anilist_id: number | null;
  poster_url: string | null;
  banner_url: string | null;
  synopsis: string | null;
  genres: string;
  tags: string;
  season_year: number | null;
  sub_languages: string;
  episode_count: number;
  total_views: number;
  total_likes: number;
  total_comments: number;
  latest_uploaded_at: number | null;
  buzz_score: number;
  buzz_tags: string;
  top_comment_quote: string | null;
  top_comment_author: string | null;
  top_comment_likes: number;
  buzz_scored_at: number | null;
  unlocked_at: number | null;
  expires_at: number | null;
  updated_at: number;
}

export interface ChannelSeriesRow {
  id: number;
  channel_id: number;
  series_id: number;
  playlist_id: string;
  playlist_title: string;
  playlist_url: string;
  thumbnail_url: string | null;
  sub_language: string;
  episode_count: number;
  playlist_item_count: number | null;
  access_note: string;
  published_at: number | null;
}

export interface EpisodeRow {
  id: number;
  channel_series_id: number;
  series_id: number;
  channel_id: number;
  youtube_video_id: string;
  title: string;
  description: string | null;
  episode_number: number | null;
  playlist_position: number;
  sub_language: string;
  duration_iso: string | null;
  thumbnail_url: string | null;
  published_at: number | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  tags: string;
  details_synced_at: number | null;
  is_members_only: number;
  unlocked_at: number | null;
  expires_at: number | null;
  region_allowed: string | null;
  region_blocked: string | null;
}

export interface LiveStreamRow {
  id: number;
  youtube_video_id: string;
  channel_id: number;
  title: string;
  thumbnail_url: string | null;
  status: 'live' | 'upcoming' | 'ended';
  concurrent_viewers: number;
  started_at: number | null;
  scheduled_start_at: number | null;
  region_allowed: string | null;
  region_blocked: string | null;
  checked_at: number;
}

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  youtube_channel_id TEXT NOT NULL UNIQUE,
  handle TEXT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  avatar_url TEXT,
  description TEXT,
  uploads_playlist_id TEXT,
  region_focus TEXT,
  sub_languages TEXT NOT NULL DEFAULT '[]',
  category TEXT NOT NULL DEFAULT 'anime',
  discovery_source TEXT NOT NULL DEFAULT 'registry',
  is_verified INTEGER NOT NULL DEFAULT 1,
  playlist_count INTEGER NOT NULL DEFAULT 0,
  last_synced_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  canonical_title TEXT NOT NULL,
  normalized_key TEXT NOT NULL UNIQUE,
  title_en TEXT,
  title_zh TEXT,
  title_romaji TEXT,
  anilist_id INTEGER UNIQUE,
  poster_url TEXT,
  banner_url TEXT,
  synopsis TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  season_year INTEGER,
  sub_languages TEXT NOT NULL DEFAULT '[]',
  episode_count INTEGER NOT NULL DEFAULT 0,
  total_views INTEGER NOT NULL DEFAULT 0,
  total_likes INTEGER NOT NULL DEFAULT 0,
  total_comments INTEGER NOT NULL DEFAULT 0,
  latest_uploaded_at INTEGER,
  buzz_score REAL NOT NULL DEFAULT 0,
  buzz_tags TEXT NOT NULL DEFAULT '[]',
  top_comment_quote TEXT,
  top_comment_author TEXT,
  top_comment_likes INTEGER NOT NULL DEFAULT 0,
  buzz_scored_at INTEGER,
  unlocked_at INTEGER,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS channel_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL,
  playlist_title TEXT NOT NULL,
  playlist_url TEXT NOT NULL,
  thumbnail_url TEXT,
  sub_language TEXT NOT NULL DEFAULT 'en',
  episode_count INTEGER NOT NULL DEFAULT 0,
  playlist_item_count INTEGER,
  access_note TEXT NOT NULL DEFAULT 'free',
  published_at INTEGER,
  UNIQUE(channel_id, playlist_id)
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_series_id INTEGER NOT NULL REFERENCES channel_series(id) ON DELETE CASCADE,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  youtube_video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  episode_number REAL,
  playlist_position INTEGER NOT NULL DEFAULT 0,
  sub_language TEXT NOT NULL DEFAULT 'en',
  duration_iso TEXT,
  thumbnail_url TEXT,
  published_at INTEGER,
  view_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  details_synced_at INTEGER,
  is_members_only INTEGER NOT NULL DEFAULT 0,
  unlocked_at INTEGER,
  expires_at INTEGER,
  region_allowed TEXT,
  region_blocked TEXT,
  UNIQUE(channel_series_id, youtube_video_id)
);

CREATE TABLE IF NOT EXISTS locked_watch_pool (
  youtube_video_id TEXT PRIMARY KEY,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  playlist_id TEXT,
  playlist_title TEXT,
  title TEXT NOT NULL,
  sub_language TEXT NOT NULL DEFAULT 'en',
  detected_reason TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS live_streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  youtube_video_id TEXT NOT NULL UNIQUE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  thumbnail_url TEXT,
  status TEXT NOT NULL DEFAULT 'live',
  concurrent_viewers INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  scheduled_start_at INTEGER,
  region_allowed TEXT,
  region_blocked TEXT,
  checked_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS series_view_snapshots (
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  captured_at INTEGER NOT NULL,
  total_views INTEGER NOT NULL,
  PRIMARY KEY (series_id, captured_at)
);

CREATE TABLE IF NOT EXISTS cache_flags (
  key TEXT PRIMARY KEY,
  dirty INTEGER NOT NULL DEFAULT 1
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS series_tags (
  tag TEXT NOT NULL,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  PRIMARY KEY (tag, series_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS region_cache_meta (
  region TEXT PRIMARY KEY,
  built_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS region_series_cache (
  region TEXT NOT NULL,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  episode_count INTEGER NOT NULL,
  sub_languages TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (region, series_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS region_cs_cache (
  region TEXT NOT NULL,
  channel_series_id INTEGER NOT NULL REFERENCES channel_series(id) ON DELETE CASCADE,
  series_id INTEGER NOT NULL,
  channel_id INTEGER NOT NULL,
  sub_language TEXT NOT NULL,
  episode_count INTEGER NOT NULL,
  PRIMARY KEY (region, channel_series_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS region_channel_cache (
  region TEXT NOT NULL,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  series_count INTEGER NOT NULL,
  total_episodes INTEGER NOT NULL,
  PRIMARY KEY (region, channel_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_channel_series_series ON channel_series(series_id);
CREATE INDEX IF NOT EXISTS idx_channel_series_channel ON channel_series(channel_id);
CREATE INDEX IF NOT EXISTS idx_episodes_series_ep ON episodes(series_id, episode_number, playlist_position);
CREATE INDEX IF NOT EXISTS idx_episodes_channel_series ON episodes(channel_series_id, episode_number, playlist_position);
CREATE INDEX IF NOT EXISTS idx_episodes_channel_geo ON episodes(channel_id, details_synced_at);
CREATE INDEX IF NOT EXISTS idx_episodes_video_id ON episodes(youtube_video_id);
CREATE INDEX IF NOT EXISTS idx_series_updated ON series(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_series_views ON series(total_views DESC);
CREATE INDEX IF NOT EXISTS idx_series_buzz ON series(buzz_score DESC);
CREATE INDEX IF NOT EXISTS idx_live_streams_status ON live_streams(status, concurrent_viewers DESC);
CREATE INDEX IF NOT EXISTS idx_series_tags_series ON series_tags(series_id);
CREATE INDEX IF NOT EXISTS idx_region_cs_series ON region_cs_cache(region, series_id, sub_language);
CREATE INDEX IF NOT EXISTS idx_region_cs_channel ON region_cs_cache(region, channel_id, series_id);

CREATE TRIGGER IF NOT EXISTS trg_series_tags_dirty_ins AFTER INSERT ON series
BEGIN
  INSERT INTO cache_flags(key, dirty) VALUES ('tags', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1 WHERE dirty = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_series_tags_dirty_upd AFTER UPDATE OF tags, genres ON series
BEGIN
  INSERT INTO cache_flags(key, dirty) VALUES ('tags', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1 WHERE dirty = 0;
END;

CREATE TRIGGER IF NOT EXISTS trg_ep_region_dirty_ins AFTER INSERT ON episodes
BEGIN
  INSERT INTO cache_flags(key, dirty) VALUES ('regions', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1 WHERE dirty = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_ep_region_dirty_upd AFTER UPDATE OF is_members_only, region_allowed, region_blocked, channel_series_id ON episodes
BEGIN
  INSERT INTO cache_flags(key, dirty) VALUES ('regions', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1 WHERE dirty = 0;
END;
CREATE TRIGGER IF NOT EXISTS trg_ep_region_dirty_del AFTER DELETE ON episodes
BEGIN
  INSERT INTO cache_flags(key, dirty) VALUES ('regions', 1) ON CONFLICT(key) DO UPDATE SET dirty = 1 WHERE dirty = 0;
END;

CREATE VIRTUAL TABLE IF NOT EXISTS series_fts USING fts5(
  series_id UNINDEXED,
  canonical_title,
  title_en,
  title_zh,
  title_romaji,
  channel_names,
  tags
);
`;
