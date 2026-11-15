import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchVideoDetailsMap, getYouTubeApiKeys, resetKeyRotation } from './youtube.ts';

test('getYouTubeApiKeys parses deduplicated keys and rotates on 403 quotaExceeded', async () => {
  const prevKeys = process.env.YOUTUBE_API_KEYS;
  const prevKey = process.env.YOUTUBE_API_KEY;
  const prevFetch = globalThis.fetch;

  try {
    resetKeyRotation();
    process.env.YOUTUBE_API_KEYS = 'key_one, key_two, key_one';
    process.env.YOUTUBE_API_KEY = 'key_two';
    assert.deepEqual(getYouTubeApiKeys(), ['key_one', 'key_two']);

    const seenKeys: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const key = new URL(url).searchParams.get('key') || '';
      seenKeys.push(key);
      if (key === 'key_one') {
        return new Response(JSON.stringify({ error: { code: 403, message: 'quotaExceeded' } }), { status: 403 });
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'vid_abc',
              snippet: { title: 'Test Ep 1', description: '' },
              contentDetails: { duration: 'PT24M' },
              statistics: { viewCount: '1234', likeCount: '56', commentCount: '7' },
              status: { privacyStatus: 'public' },
            },
          ],
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const details = await fetchVideoDetailsMap(['vid_abc']);
    assert.deepEqual(seenKeys, ['key_one', 'key_two']);
    assert.equal(details.get('vid_abc')?.viewCount, 1234);
  } finally {
    globalThis.fetch = prevFetch;
    resetKeyRotation();
    if (prevKeys === undefined) delete process.env.YOUTUBE_API_KEYS;
    else process.env.YOUTUBE_API_KEYS = prevKeys;
    if (prevKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = prevKey;
  }
});
