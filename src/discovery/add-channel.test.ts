import test from 'node:test';
import assert from 'node:assert/strict';
import { closeDatabase, openDatabase } from '../db/index.ts';
import {
  parseChannelInput,
  reconcileMissingSeedChannels,
  upsertChannel,
} from './add-channel.ts';
import type { YtChannelInfo } from '../lib/youtube.ts';

function fakeChannel(id: string, title: string, handle: string): YtChannelInfo {
  return {
    id,
    title,
    description: `${title} official anime`,
    customUrl: handle,
    avatarUrl: null,
    uploadsPlaylistId: `UU${id.slice(2)}`,
    videoCount: 40,
  };
}

test('parseChannelInput handles URLs, handles, and UC channel IDs', () => {
  assert.deepEqual(parseChannelInput('@MuseAsia'), { handle: '@MuseAsia' });
  assert.deepEqual(parseChannelInput('@MuseAsia?si=abc123'), { handle: '@MuseAsia' });
  assert.deepEqual(parseChannelInput('https://www.youtube.com/@AniOneAsia/playlists'), {
    handle: '@AniOneAsia',
  });
  assert.deepEqual(parseChannelInput('https://youtube.com/channel/UCGbshtvS9t-8CW11W7TooQg/videos'), {
    channelId: 'UCGbshtvS9t-8CW11W7TooQg',
  });
  assert.deepEqual(parseChannelInput('UCGbshtvS9t-8CW11W7TooQg'), {
    channelId: 'UCGbshtvS9t-8CW11W7TooQg',
  });
  assert.deepEqual(parseChannelInput('MuseTW'), { handle: '@MuseTW' });
  assert.equal(parseChannelInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseChannelInput('https://evil.example.com/@MuseAsia'), null);
  assert.equal(parseChannelInput('   '), null);
});

test('upsertChannel preserves manual and rejected channels across search discovery', () => {
  closeDatabase();
  const db = openDatabase(':memory:');

  const manualInfo = fakeChannel('UC_MANUAL_0000001', 'Manual Anime', '@ManualAnime');
  upsertChannel(db, {
    info: manualInfo,
    handle: '@ManualAnime',
    category: 'anime',
    regionFocus: 'Global',
    subLanguages: ['en'],
    discoverySource: 'manual',
    isVerified: true,
    playlistCount: 12,
  });

  // Subsequent search_pending pass must not downgrade manual channel
  upsertChannel(db, {
    info: manualInfo,
    handle: '@ManualAnime',
    category: 'anime',
    regionFocus: 'Global',
    subLanguages: ['en'],
    discoverySource: 'search_pending',
    isVerified: false,
    playlistCount: 14,
  });

  const manualRow = db
    .prepare('SELECT discovery_source, is_verified, playlist_count FROM channels WHERE youtube_channel_id = ?')
    .get('UC_MANUAL_0000001') as { discovery_source: string; is_verified: number; playlist_count: number };
  assert.equal(manualRow.discovery_source, 'manual');
  assert.equal(manualRow.is_verified, 1);
  assert.equal(manualRow.playlist_count, 14);

  // Rejected channel stays rejected when re-seen by search discovery
  const rejInfo = fakeChannel('UC_REJECT_0000002', 'Spam Channel', '@SpamAnime');
  upsertChannel(db, {
    info: rejInfo,
    handle: '@SpamAnime',
    category: 'anime',
    regionFocus: 'Global',
    subLanguages: ['en'],
    discoverySource: 'rejected',
    isVerified: false,
    playlistCount: 5,
  });
  upsertChannel(db, {
    info: rejInfo,
    handle: '@SpamAnime',
    category: 'anime',
    regionFocus: 'Global',
    subLanguages: ['en'],
    discoverySource: 'search_pending',
    isVerified: false,
    playlistCount: 6,
  });

  const rejRow = db
    .prepare('SELECT discovery_source, is_verified FROM channels WHERE youtube_channel_id = ?')
    .get('UC_REJECT_0000002') as { discovery_source: string; is_verified: number };
  assert.equal(rejRow.discovery_source, 'rejected');
  assert.equal(rejRow.is_verified, 0);

  closeDatabase();
});

test('reconcileMissingSeedChannels only resolves missing entries', async () => {
  closeDatabase();
  const db = openDatabase(':memory:');

  upsertChannel(db, {
    info: fakeChannel('UC_EXISTING_00001', 'Existing Official', '@ExistingOfficial'),
    handle: '@ExistingOfficial',
    category: 'anime',
    regionFocus: 'Asia',
    subLanguages: ['en'],
    discoverySource: 'registry',
    isVerified: true,
    playlistCount: 10,
  });

  const resolvedHandles: string[] = [];
  const added = await reconcileMissingSeedChannels(db, {
    seeds: [
      {
        name: 'Existing Official',
        handle: '@ExistingOfficial',
        category: 'anime',
        regionFocus: 'Asia',
        defaultSubLanguages: ['en'],
      },
      {
        name: 'New Official',
        handle: '@NewOfficial',
        category: 'anime',
        regionFocus: 'Global',
        defaultSubLanguages: ['en'],
      },
    ],
    resolveIds: async () => [],
    resolveHandle: async (handle) => {
      resolvedHandles.push(handle);
      return fakeChannel('UC_NEW_0000000002', 'New Official', handle);
    },
    verifyChannel: async () => ({
      ok: true,
      playlistCount: 4,
      qualifyingPlaylists: 4,
      subLanguages: ['en'],
    }),
  });

  assert.equal(added, 1);
  assert.deepEqual(resolvedHandles, ['@NewOfficial']);

  // Second run resolves nothing (0 quota)
  const addedAgain = await reconcileMissingSeedChannels(db, {
    seeds: [
      {
        name: 'Existing Official',
        handle: '@ExistingOfficial',
        category: 'anime',
        regionFocus: 'Asia',
        defaultSubLanguages: ['en'],
      },
      {
        name: 'New Official',
        handle: '@NewOfficial',
        category: 'anime',
        regionFocus: 'Global',
        defaultSubLanguages: ['en'],
      },
    ],
    resolveHandle: async () => {
      throw new Error('Should not be called when already reconciled');
    },
  });
  assert.equal(addedAgain, 0);

  closeDatabase();
});
