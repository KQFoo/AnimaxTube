import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSeriesTitle,
  detectChineseScript,
  detectSubLanguage,
  extractEpisodeNumber,
  extractExpiryDate,
  isMembersOnlyPlaylist,
  isMembersOnlyText,
  isNonSeriesPlaylist,
  isPromoVideo,
  normalizeSeriesKey,
  buildEngagementModel,
  isNegatedAt,
  scoreCommentsForRecommendation,
  smoothedEngagementRate,
  wilsonLowerBound,
} from './title-parser.ts';

test('detectSubLanguage differentiates EN, Traditional Chinese, Simplified Chinese, and Multi', () => {
  assert.equal(detectSubLanguage('Frieren: Beyond Journey’s End [Eng Sub]', 'en'), 'en');
  assert.equal(detectSubLanguage('《葬送的芙莉蓮》第1話 (繁中字幕｜Muse木棉花)', 'zh-Hant'), 'zh-Hant');
  assert.equal(detectSubLanguage('【简中】时光代理人 第一季', 'zh-Hans'), 'zh-Hans');
  assert.equal(detectSubLanguage('[Eng Sub]【中文字幕】Link Click EP01', 'en'), 'multi');
  assert.equal(detectChineseScript('這是一個繁體中文測試'), 'zh-Hant');
  assert.equal(detectChineseScript('这是一个简体中文测试'), 'zh-Hans');
});

test('extractEpisodeNumber parses English and CJK episode patterns', () => {
  assert.equal(extractEpisodeNumber('Frieren Episode 01 [Eng Sub]'), 1);
  assert.equal(extractEpisodeNumber('Dandadan EP12.5 Special'), 12.5);
  assert.equal(extractEpisodeNumber('《葬送的芙莉蓮》第28話 (繁中)'), 28);
  assert.equal(extractEpisodeNumber('Mobile Suit Gundam #04'), 4);
  assert.equal(extractEpisodeNumber('Prologue: The Beginning'), 0);
});

test('isNonSeriesPlaylist and isPromoVideo filter non-episode content', () => {
  assert.equal(isNonSeriesPlaylist('Seasonal Trailers & PVs'), true);
  assert.equal(isNonSeriesPlaylist('ONE PIECE Moments'), true);
  assert.equal(isNonSeriesPlaylist('🏃Full Season Marathon🏃'), true);
  assert.equal(isNonSeriesPlaylist('Anime Opening & Ending Music Videos'), true);
  assert.equal(isNonSeriesPlaylist('Frieren: Beyond Journey’s End [Eng Sub]'), false);
  assert.equal(isPromoVideo('Solo Leveling Main Trailer PV'), true);
  assert.equal(isPromoVideo('Solo Leveling Episode 01 [Eng Sub]'), false);
  assert.equal(isMembersOnlyText('Ani-One ULTRA Members Only Episode 5'), true);
});

test('cleanSeriesTitle and normalizeSeriesKey group episodes consistently', () => {
  const a = cleanSeriesTitle('《葬送的芙莉蓮》第01話【繁中字幕】｜Muse木棉花');
  assert.equal(a, '葬送的芙莉蓮');
  assert.equal(
    normalizeSeriesKey('Frieren: Beyond Journey’s End [Eng Sub] | Muse Asia'),
    normalizeSeriesKey('Frieren Beyond Journeys End (Full Episodes)')
  );
});

test('isMembersOnlyPlaylist detects ULTRA and Chinese/English membership playlists', () => {
  assert.equal(isMembersOnlyPlaylist('【Ani-One ULTRA】Solo Leveling Members Only'), true);
  assert.equal(isMembersOnlyPlaylist('會員限定動畫《藥師少女的獨語》'), true);
  assert.equal(isMembersOnlyPlaylist('會員搶先看'), true);
  assert.equal(isMembersOnlyPlaylist('Solo Leveling [Eng Sub]'), false);
});

test('extractExpiryDate parses English and CJK expiry windows', () => {
  const enTs = extractExpiryDate('Available until: December 31, 2026 (GMT+8). Enjoy!');
  assert.ok(enTs !== null && enTs > 1700000000);
  const cjkTs = extractExpiryDate('限時免費至：2026年11月30日。');
  assert.ok(cjkTs !== null && cjkTs > 1700000000);
  assert.equal(extractExpiryDate('Regular permanent upload with no expiry.'), null);
});

test('scoreCommentsForRecommendation filters spoilers and extracts praise tags & quote', () => {
  const result = scoreCommentsForRecommendation(
    [
      { author: '@spoiler', text: 'Major spoiler warning: everyone dies in the ending!', likeCount: 999 },
      { author: '@spam', text: 'Anyone watching in 2026??', likeCount: 500 },
      {
        author: '@critic',
        text: 'Truly an underrated hidden gem with incredible animation and soundtrack!',
        likeCount: 320,
      },
    ],
    { viewCount: 250000, likeCount: 12000, commentCount: 600 }
  );

  assert.ok(result.buzzScore > 0);
  assert.ok(result.buzzTags.includes('Hidden Gem'));
  assert.ok(result.buzzTags.includes('Great Production'));
  assert.equal(result.topCommentAuthor, '@critic');
  assert.equal(result.topCommentLikes, 320);
  assert.match(result.topCommentQuote || '', /hidden gem/i);
  assert.ok(result.buzzScore >= 0 && result.buzzScore <= 100);
});

test('negated praise does not count toward buzz', () => {
  assert.equal(isNegatedAt('This is not a masterpiece at all, sadly', 'This is not a '.length), true);
  assert.equal(isNegatedAt('這部不推薦給新手觀眾看看看', '這部不'.length), true);
  assert.equal(isNegatedAt('An absolute masterpiece from start to finish', 'An absolute '.length), false);

  const negated = scoreCommentsForRecommendation(
    [
      { author: '@a', text: 'Honestly this is not a masterpiece, pretty mid overall', likeCount: 50 },
      { author: '@b', text: 'It was never worth watching past the intro sequence', likeCount: 40 },
    ],
    { viewCount: 100000, likeCount: 3000, commentCount: 100 }
  );
  assert.equal(negated.components.praise, 0);
  assert.equal(negated.components.quote, 0);
  assert.deepEqual(negated.buzzTags, []);
  // Display quote falls back to the most-liked safe comment.
  assert.equal(negated.topCommentAuthor, '@a');
});

test('engagement smoothing keeps tiny samples near the global rate', () => {
  const global = 0.04;
  const tiny = smoothedEngagementRate({ viewCount: 50, likeCount: 40, commentCount: 5 }, global);
  const big = smoothedEngagementRate({ viewCount: 500000, likeCount: 40000, commentCount: 5000 }, global);
  // Raw rate would be (40 + 15) / 50 = 1.1; the prior pulls it back near 0.04.
  assert.ok(Math.abs(tiny - global) < 0.015);
  assert.ok(big > 0.1);

  const model = buildEngagementModel([
    { viewCount: 100000, likeCount: 2000, commentCount: 50 },
    { viewCount: 100000, likeCount: 4000, commentCount: 100 },
    { viewCount: 100000, likeCount: 8000, commentCount: 300 },
  ]);
  const hi = model.normalize(smoothedEngagementRate({ viewCount: 100000, likeCount: 9000, commentCount: 400 }, model.globalRate));
  const lo = model.normalize(smoothedEngagementRate({ viewCount: 100000, likeCount: 1000, commentCount: 10 }, model.globalRate));
  assert.equal(hi, 1);
  assert.equal(lo, 0);
});

test('Wilson lower bound rewards larger praise samples', () => {
  assert.ok(wilsonLowerBound(20, 25) > wilsonLowerBound(2, 3));
  assert.equal(wilsonLowerBound(0, 0), 0);
});

test('buzz score stays within 0..100 for extreme inputs', () => {
  const praise = Array.from({ length: 25 }, (_, i) => ({
    author: `@fan${i}`,
    text: 'Underrated masterpiece, I rewatched it and cried, amazing soundtrack',
    likeCount: 100000,
  }));
  const max = scoreCommentsForRecommendation(praise, { viewCount: 1000, likeCount: 1000, commentCount: 1000 });
  assert.ok(max.buzzScore <= 100 && max.buzzScore > 50);
  const min = scoreCommentsForRecommendation([], { viewCount: 0, likeCount: 0, commentCount: 0 });
  assert.ok(min.buzzScore >= 0);
});
