const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const HAN_ALL_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/g;
const KANA_ALL_RE = /[\u3040-\u30ff]/g;

const SIMPLIFIED_ONLY =
  '这们话说时间后发动画无东车长门开关现学实点种应战剧场爱乐页际会经级结继续选择识谁让证记设语钟银铁错饭马鸟龙风飞气电书买卖与为个国图园圣坏声处备头夺宝尝尽层岁岛带帮广庆异弹归当录忆怀恋恶惊戏户执扩扫护报担拥换据摄敌数斗断旧显晓术机杀杂权条来杨极构枪样桥检欢毕汉没泪泽洁浅测济浓渐温湾满灭灵灾热爷献环疗盖码确礼离积称穷笔简纪约红线练组细终绝绘给统网罗职联脑脸舰节范荣药获虫补装见观规视觉训讲许论访诉词试诗该详误请读谈谜贝负贵费资赏赛赶转轮软轻较边达过运还进远连迟适递遗邻释针钢钱链锁闪问闻队阳阴陆险随隐难雾静韩顶项顺须顾预领频题颜饮验骑鱼鸡鹰黄齐龟';
const TRADITIONAL_ONLY =
  '這們話說時間後發動畫無東車長門開關現學實點種應戰劇場愛樂頁際會經級結繼續選擇識誰讓證記設語鐘銀鐵錯飯馬鳥龍風飛氣電書買賣與為個國圖園聖壞聲處備頭奪寶嘗盡層歲島帶幫廣慶異彈歸當錄憶懷戀惡驚戲戶執擴掃護報擔擁換據攝敵數鬥斷舊顯曉術機殺雜權條來楊極構槍樣橋檢歡畢漢沒淚澤潔淺測濟濃漸溫灣滿滅靈災熱爺獻環療蓋碼確禮離積稱窮筆簡紀約紅線練組細終絕繪給統網羅職聯腦臉艦節範榮藥獲蟲補裝見觀規視覺訓講許論訪訴詞試詩該詳誤請讀談謎貝負貴費資賞賽趕轉輪軟輕較邊達過運還進遠連遲適遞遺鄰釋針鋼錢鏈鎖閃問聞隊陽陰陸險隨隱難霧靜韓頂項順須顧預領頻題顏飲驗騎魚雞鷹黃齊龜';

const SIMPLIFIED_SET = new Set(SIMPLIFIED_ONLY);
const TRADITIONAL_SET = new Set(TRADITIONAL_ONLY);

export type SubLanguage = 'en' | 'zh-Hant' | 'zh-Hans' | 'multi' | 'other';

const TAG_PATTERNS: Array<{ regex: RegExp; lang: SubLanguage }> = [
  { regex: /繁中|繁體|繁体|正體|中文字幕[^\]】]*繁|Traditional Chinese|\bCHT\b/i, lang: 'zh-Hant' },
  { regex: /简中|简体|簡體|中文字幕[^\]】]*简|Simplified Chinese|\bCHS\b/i, lang: 'zh-Hans' },
  { regex: /中文字幕|中文版|中字|華語字幕|华语字幕|[\[【(（]\s*中文\s*[\]】)）]|國語|粵語/i, lang: 'zh-Hant' },
  {
    regex:
      /Eng(?:lish)?[\s-]*Subs?\b|EngSub|\bENG\s*SUB|\bEnglish\s*Subtitles?\b|\bEng\s*Dub\b|[\[【]\s*(?:English|Eng)\s*[\]】]/i,
    lang: 'en',
  },
  { regex: /Multi[\s-]*Sub/i, lang: 'multi' },
  { regex: /Malay(?:u)?[\s-]*Sub|Bahasa Melayu|Sari Kata/i, lang: 'other' },
  { regex: /Indo(?:nesia)?[\s-]*Sub|Sub Indo|Bahasa Indonesia|Subtitle Indonesia/i, lang: 'other' },
  { regex: /Thai[\s-]*Sub|ซับไทย|ภาษาไทย/i, lang: 'other' },
  { regex: /Viet(?:namese)?[\s-]*Sub|Tiếng Việt|Vietsub/i, lang: 'other' },
];

export function detectChineseScript(text: string, fallback: 'zh-Hant' | 'zh-Hans' = 'zh-Hant'): 'zh-Hant' | 'zh-Hans' | null {
  if (!HAN_RE.test(text)) return null;
  const han = text.match(HAN_ALL_RE)?.length ?? 0;
  const kana = text.match(KANA_ALL_RE)?.length ?? 0;
  if (kana > 0 && kana * 4 >= han + kana) return null;

  let simplified = 0;
  let traditional = 0;
  for (const ch of text) {
    if (SIMPLIFIED_SET.has(ch)) simplified++;
    else if (TRADITIONAL_SET.has(ch)) traditional++;
  }
  if (simplified > traditional) return 'zh-Hans';
  if (traditional > simplified) return 'zh-Hant';
  return fallback;
}

export function detectSubLanguage(
  title: string,
  channelDefault: SubLanguage = 'en',
  youtubeDefaultLang?: string | null
): SubLanguage {
  const hasEnTag = /Eng(?:lish)?[\s-]*Subs?\b|EngSub|\bENG\s*SUB|\bEnglish\s*Subtitles?\b|\bEng\s*Dub\b/i.test(title);
  const hasZhTag = /繁中|繁體|繁体|中文字幕|中文版|中字|简中|简体|簡體|華語字幕|华语字幕/i.test(title);
  if (hasEnTag && hasZhTag) return 'multi';

  for (const { regex, lang } of TAG_PATTERNS) {
    if (regex.test(title)) {
      if (lang === 'zh-Hant' && !/繁|正體|CHT|粵語/.test(title)) {
        const script = detectChineseScript(title, channelDefault === 'zh-Hans' ? 'zh-Hans' : 'zh-Hant');
        return script ?? 'zh-Hant';
      }
      return lang;
    }
  }

  if (youtubeDefaultLang) {
    const l = youtubeDefaultLang.toLowerCase();
    if (/^zh-(tw|hk|mo|hant)/.test(l)) return 'zh-Hant';
    if (/^zh-(cn|sg|hans)/.test(l)) return 'zh-Hans';
    if (l.startsWith('en')) return 'en';
  }

  const script = detectChineseScript(title, channelDefault === 'zh-Hans' ? 'zh-Hans' : 'zh-Hant');
  if (script) return script;

  return channelDefault;
}

const NON_SERIES_PLAYLIST_PATTERNS = [
  /\bshorts?\b/i,
  /\bpv\b|promotion(?:al)?\s*video|trailers?|teasers?/i,
  /\bmusic\s*videos?\b|\bmv\b|\bost\b|opening|ending|\bop\s*&\s*ed\b|主題曲|片頭曲|片尾曲|OPED/i,
  /\bclips?\b|\bhighlights?\b|\bmoments\b|\bfights\b|\bkisses\b|anime\s+girls\s+fighting|best\s+anime|精華|名場面|預告/i,
  /\binterviews?\b|behind the scenes|voice actors?|cast|live\s*stream|event|announcements?/i,
  /\btoy\b|\bgunpla\b|\bmodel\s*kit\b|\bmerch\b|\bunboxing\b|\bcommercials?\b|\bcm\b/i,
  /\bgameplay\b|\bgaming\b|\bpodcast\b|\brecaps?\b|\breaction\b/i,
  /\bmarathon\b|馬拉松|串燒|合集|小編自製|動畫資訊|新番資訊|直播存檔/i,
  /\bmembers?\s*only\b|\bmembership\b|\bani-one\s+ultra\b|會員限定|會員專屬|會員搶先|僅限會員/i,
];

export function isNonSeriesPlaylist(playlistTitle: string): boolean {
  const t = playlistTitle.trim();
  if (!t) return true;
  return NON_SERIES_PLAYLIST_PATTERNS.some((re) => re.test(t));
}

export type SongType = 'op' | 'ed' | 'ost';

const MUSIC_PLAYLIST_RE =
  /\bmusic\s*videos?\b|\bmv\b|\bost\b|\bsoundtrack\b|\bopening\b|\bending\b|\bop\s*[&/]\s*ed\b|\boped\b|\btheme\s*songs?\b|\binsert\s*songs?\b|\bcharacter\s*songs?\b|\bncop\b|\bnced\b|主題曲|主题曲|片頭曲|片头曲|片尾曲|插曲|原聲帶|原声带|角色歌/i;

const SONG_OP_RE =
  /\b(?:creditless\s+)?openings?\b|\bop\s*(?:\d+|ver\.?|version|theme|movie)?\b|\bncop\d*\b|片頭曲|片头曲|無字幕\s*op|无字幕\s*op|オープニング/i;

const SONG_ED_RE =
  /\b(?:creditless\s+)?endings?\b|\bed\s*(?:\d+|ver\.?|version|theme|movie)?\b|\bnced\d*\b|片尾曲|無字幕\s*ed|无字幕\s*ed|エンディング/i;

const SONG_OST_RE =
  /\bost\b|\boriginal\s*soundtrack\b|\bsoundtrack\b|\bbgm\b|\binsert\s*song\b|\btheme\s*song\b|\bmusic\s*video\b|\bcharacter\s*song\b|\bimage\s*song\b|\bmv\b|主題曲|主题曲|插曲|原聲帶|原声带|角色歌|劇中歌|剧中歌/i;

const NON_SONG_NOISE_RE =
  /#shorts\b|\bgameplay\b|\bgaming\b|\bpodcast\b|\bunboxing\b|\bmerch\b|\bgunpla\b|\binterview\b|\breaction\b|\bmarathon\b|馬拉松/i;

export function isMusicPlaylist(playlistTitle: string): boolean {
  const t = playlistTitle.trim();
  if (!t || isMembersOnlyPlaylist(t)) return false;
  return MUSIC_PLAYLIST_RE.test(t);
}

export function classifyAnimeSong(videoTitle: string, playlistTitle = ''): SongType | null {
  const title = videoTitle.trim();
  if (!title || NON_SONG_NOISE_RE.test(title)) return null;
  if (SONG_OP_RE.test(title)) return 'op';
  if (SONG_ED_RE.test(title)) return 'ed';
  if (SONG_OST_RE.test(title)) return 'ost';

  if (playlistTitle && isMusicPlaylist(playlistTitle)) {
    if (/\bpreview\b|\btrailer\b|\bteaser\b|預告/i.test(title)) return null;
    if (SONG_OP_RE.test(playlistTitle) && !SONG_ED_RE.test(playlistTitle)) return 'op';
    if (SONG_ED_RE.test(playlistTitle) && !SONG_OP_RE.test(playlistTitle)) return 'ed';
    return 'ost';
  }
  return null;
}

export function isMembersOnlyPlaylist(playlistTitle: string): boolean {
  return /\bmembers?\s*only\b|\bmembership\b|\bani-one\s+ultra\b|\bultra\b.*(?:ani-one|會員)|會員限定|會員專屬|會員搶先|僅限會員/i.test(
    playlistTitle
  );
}

const PROMO_VIDEO_PATTERNS = [
  /\bpreview\b/i,
  /\btrailer\b/i,
  /\bteaser\b/i,
  /\bcoming\s*soon\b/i,
  /#shorts\b/i,
  /\bhighlight(?:s)?\b/i,
  /\bpromotion(?:al)?\s*video\b/i,
  /\bcharacter\s*pv\b|\bmain\s*pv\b|\bpv\s*\d*\b/i,
  /\bcreditless\s*(?:op|ed|opening|ending)\b/i,
  /預告片|前導預告|宣傳片|角色PV|無字幕OP|無字幕ED/i,
];

export function isPromoVideo(videoTitle: string): boolean {
  return PROMO_VIDEO_PATTERNS.some((re) => re.test(videoTitle));
}

const MEMBERSHIP_INDICATORS = [
  'ani-one ultra',
  'members only',
  'membership only',
  'members-only',
  'join this channel to get access',
  'channel member',
  'join to unlock',
  '會員搶先看',
  '會員搶先',
  '會員專屬',
  '會員限定',
  '僅限會員',
  '頻道會員',
];

export function isMembersOnlyText(text: string): boolean {
  const lower = text.toLowerCase();
  return MEMBERSHIP_INDICATORS.some((ind) => lower.includes(ind));
}

const EXPIRY_REGEX =
  /(?:Available until|Expires on|Streaming until|License ends(?: on)?|Available till|Limited time until|Removal date|限時免費至|期間限定至)\s*[:：\-]?\s*([A-Za-z0-9,\s.\-/:()+年月日時分]+?)(?:\.|。|\n|\r|$)/i;

export function extractExpiryDate(rawDescription: string): number | null {
  if (!rawDescription) return null;
  const match = rawDescription.match(EXPIRY_REGEX);
  if (!match) return null;
  const raw = match[1].replace(/\(?(?:GMT|UTC)[+\-]?\d{1,2}(?::?\d{2})?\)?/gi, '').trim();
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  const cjk = raw.match(/(\d{4})\s*[年/\-]\s*(\d{1,2})\s*[月/\-]\s*(\d{1,2})/);
  if (cjk) {
    const dt = Date.UTC(parseInt(cjk[1], 10), parseInt(cjk[2], 10) - 1, parseInt(cjk[3], 10), 15, 59);
    return Math.floor(dt / 1000);
  }
  return null;
}

export interface CommentInput {
  author: string;
  text: string;
  likeCount: number;
}

const SPOILER_OR_SPAM_RE =
  /spoiler|劇透|爆雷|雷區|\bdies\b|\bdied\b|\bdeath\b|死了|便當|結局|ending|who'?s watching in 20\d\d|anyone in 20\d\d|\bfirst\b!|\bearly\b|^\d{1,2}:\d{2}|http[s]?:\/\//i;

const PRAISE_PATTERNS: Array<{ re: RegExp; tag: string; weight: number }> = [
  { re: /\bunderrated\b|\bhidden gem\b|被低估|寶藏/i, tag: 'Hidden Gem', weight: 18 },
  { re: /\bmasterpiece\b|\bpeak\b|10\/10|神作|封神/i, tag: 'Masterpiece', weight: 16 },
  { re: /\brewatch(?:ing|ed)?\b|重刷|二刷|三刷/i, tag: 'Rewatchable', weight: 12 },
  { re: /\bemotion(?:al)?\b|\bcried\b|\btears\b|催淚|好哭|破防/i, tag: 'Emotional', weight: 12 },
  { re: /\banimation\b|\bsoundtrack\b|\bost\b|作畫|經費|配樂/i, tag: 'Great Production', weight: 10 },
  { re: /\bfunny\b|\bhilarious\b|\bcomedy\b|笑死|超好笑/i, tag: 'Comedy Hit', weight: 10 },
  { re: /\bcomfort\b|\bwholesome\b|\bcozy\b|治癒|療癒|舒壓/i, tag: 'Comfort Watch', weight: 10 },
  { re: /超好看|必看|推薦|停不下來|真香|amazing|incredible|worth watching/i, tag: 'Viewer Favorite', weight: 9 },
];

const EN_NEGATION_RE = /\b(?:not|isn'?t|wasn'?t|aren'?t|never|no|hardly)\b/i;
const CJK_NEGATION_RE = /[不沒没別别]/;

/** True when a negation word sits within ~3 words (EN) or 3 characters (CJK) before `index`. */
export function isNegatedAt(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 32), index);
  const lastWords = before.trim().split(/\s+/).slice(-3).join(' ');
  if (EN_NEGATION_RE.test(lastWords)) return true;
  return CJK_NEGATION_RE.test(before.slice(-3));
}

/** Lower bound of the Wilson score interval: a sample-size-aware proportion. */
export function wilsonLowerBound(successes: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (center - margin) / (1 + z2 / total));
}

export const ENGAGEMENT_PRIOR_VIEWS = 5000;
export const DEFAULT_GLOBAL_ENGAGEMENT_RATE = 0.04;

/** (likes + 3*comments) per view, shrunk toward `globalRate` by a prior of `priorViews` views. */
export function smoothedEngagementRate(
  stats: { viewCount: number; likeCount: number; commentCount: number },
  globalRate = DEFAULT_GLOBAL_ENGAGEMENT_RATE,
  priorViews = ENGAGEMENT_PRIOR_VIEWS
): number {
  const views = Math.max(0, stats.viewCount || 0);
  const interactions = Math.max(0, stats.likeCount || 0) + 3 * Math.max(0, stats.commentCount || 0);
  return (interactions + priorViews * globalRate) / (views + priorViews);
}

export interface EngagementModel {
  globalRate: number;
  /** Maps a smoothed engagement rate to 0..1. */
  normalize: (rate: number) => number;
}

/**
 * Builds a catalog-wide engagement model: the pooled global rate plus a percentile
 * normalizer over every sample's smoothed rate.
 */
export function buildEngagementModel(
  samples: Array<{ viewCount: number; likeCount: number; commentCount: number }>
): EngagementModel {
  let views = 0;
  let interactions = 0;
  for (const s of samples) {
    views += Math.max(0, s.viewCount || 0);
    interactions += Math.max(0, s.likeCount || 0) + 3 * Math.max(0, s.commentCount || 0);
  }
  const globalRate = views > 0 ? interactions / views : DEFAULT_GLOBAL_ENGAGEMENT_RATE;
  const sorted = samples.map((s) => smoothedEngagementRate(s, globalRate)).sort((a, b) => a - b);

  const normalize = (rate: number) => {
    if (sorted.length === 0) return rate / (rate + globalRate);
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= rate) lo = mid + 1;
      else hi = mid;
    }
    return lo / sorted.length;
  };
  return { globalRate, normalize };
}

const DEFAULT_ENGAGEMENT_MODEL: EngagementModel = {
  globalRate: DEFAULT_GLOBAL_ENGAGEMENT_RATE,
  normalize: (rate) => rate / (rate + DEFAULT_GLOBAL_ENGAGEMENT_RATE),
};

export const BUZZ_WEIGHTS = { engagement: 0.4, praise: 0.4, quote: 0.2 };

/**
 * Scores Episode-1 comments plus that episode's own stats into a 0..100 buzz score.
 */
export function scoreCommentsForRecommendation(
  comments: CommentInput[],
  stats: { viewCount: number; likeCount: number; commentCount: number },
  model: EngagementModel = DEFAULT_ENGAGEMENT_MODEL
): {
  buzzScore: number;
  buzzTags: string[];
  topCommentQuote: string | null;
  topCommentAuthor: string | null;
  topCommentLikes: number;
  components: { engagement: number; praise: number; quote: number };
} {
  const safeComments = comments
    .map((c) => ({ ...c, clean: c.text.replace(/\s+/g, ' ').trim() }))
    .filter((c) => c.clean.length >= 18 && c.clean.length <= 150 && !SPOILER_OR_SPAM_RE.test(c.clean));

  const tagWeights = new Map<string, number>();
  let praiseHits = 0;
  let bestQuote: { clean: string; author: string; likeCount: number; praiseWeight: number; rank: number } | null = null;

  for (const c of safeComments) {
    let praiseWeight = 0;
    for (const p of PRAISE_PATTERNS) {
      const m = p.re.exec(c.clean);
      if (!m || isNegatedAt(c.clean, m.index)) continue;
      praiseWeight += p.weight;
      tagWeights.set(p.tag, (tagWeights.get(p.tag) || 0) + p.weight);
    }
    if (praiseWeight === 0) continue;
    praiseHits++;
    const rank = Math.log10(c.likeCount + 1) * 4 + praiseWeight;
    if (!bestQuote || rank > bestQuote.rank) {
      bestQuote = { clean: c.clean, author: c.author, likeCount: c.likeCount, praiseWeight, rank };
    }
  }

  const quote = bestQuote
    ? 0.5 * Math.min(1, Math.log10(bestQuote.likeCount + 1) / 4) + 0.5 * Math.min(1, bestQuote.praiseWeight / 30)
    : 0;

  // Without praise, keep the most-liked safe comment for display only.
  const displayQuote =
    bestQuote ?? (safeComments.length > 0 ? [...safeComments].sort((a, b) => b.likeCount - a.likeCount)[0] : null);

  const engagement = Math.min(1, Math.max(0, model.normalize(smoothedEngagementRate(stats, model.globalRate))));
  const praise = wilsonLowerBound(praiseHits, safeComments.length);
  const buzzScore = Number(
    (100 * (BUZZ_WEIGHTS.engagement * engagement + BUZZ_WEIGHTS.praise * praise + BUZZ_WEIGHTS.quote * quote)).toFixed(2)
  );

  const buzzTags = [...tagWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);

  return {
    buzzScore,
    buzzTags,
    topCommentQuote: displayQuote ? displayQuote.clean : null,
    topCommentAuthor: displayQuote ? displayQuote.author : null,
    topCommentLikes: displayQuote ? displayQuote.likeCount : 0,
    components: { engagement, praise, quote },
  };
}

export function extractEpisodeNumber(rawTitle: string): number | null {
  const explicitPatterns = [
    /(?:Episode|Ep\.?|EP)\s*(\d+(?:\.\d+)?)/i,
    /第\s*(\d+(?:\.\d+)?)\s*(?:話|话|回|集)/,
    /[#＃]\s*(\d+(?:\.\d+)?)(?:\s|$|[\]】｜|])/,
    /\bE(\d{1,3}(?:\.\d+)?)\b/i,
  ];
  for (const re of explicitPatterns) {
    const m = rawTitle.match(re);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n < 2000) return n;
    }
  }

  const bare = rawTitle.match(/(?:^|[\s\-–—\[\(【])(\d{1,3}(?:\.\d+)?)(?:\s|$|[\]\)】｜|])/);
  if (bare) {
    const n = parseFloat(bare[1]);
    if (Number.isFinite(n) && n < 1500) return n;
  }

  if (/\bprologue\b|序章|第0話/i.test(rawTitle)) return 0;
  return null;
}

const DISTRIBUTOR_NOISE_RE =
  /Muse\s*木棉花(?:-?(?:TW|HK|闔家歡))?(?:\s*動畫)?|\b(?:Muse\s*(?:Asia|TW|HK|Malaysia|Philippines|India)|Ani-One\s*(?:Asia|Ultra|China|Philippines)?|Ani-Mi(?:\s*Asia)?|GundamInfo|Tropics\s*Anime(?:\s*Asia)?|It'?s\s*Anime|REMOW|TMS\s*Official|RetroCrush|MadeByBilibili|Made\s*By\s*Bilibili|Tencent\s*Video|YOUKU|iQIYI|Full\s*Episodes?|All\s*Episodes?|Eng(?:lish)?\s*Subs?|EngSub|Multi[\s-]*Sub|Official)\b|木棉花|羚邦|動漫迷|官方頻道|全集|完整版|線上看|中文字幕|繁體中文|簡體中文|繁中|簡中|正版/gi;

export function cleanSeriesTitle(rawTitle: string): string {
  // Prefer 《Title》 if the Chinese title is inside guillemets and rest is episode/tag noise
  const strippedBrackets = rawTitle
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/《([^》]*)》/g, ' $1 ')
    .replace(/「([^」]*)」/g, ' $1 ')
    .replace(/\([^)]*(?:sub|dub|full|hd|4k|eng|zh|cht|chs|official|remaster|muse|ani-one)[^)]*\)/gi, ' ');

  let cleaned = strippedBrackets
    .replace(/第\s*\d+(?:\.\d+)?\s*(?:話|话|回|集)(?:\s*[~～\-–—]\s*第?\s*\d+\s*(?:話|话|回|集))?/gi, ' ')
    .replace(/(?:Episode|EP|Ep\.?)\s*\d+(?:\.\d+)?(?:\s*[~～\-–—]\s*\d+)?/gi, ' ')
    .replace(/[#＃]\s*\d+(?:\.\d+)?/g, ' ')
    .replace(DISTRIBUTOR_NOISE_RE, ' ')
    .replace(/[｜|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  cleaned = cleaned.replace(/^[\s\-–—:：~～]+|[\s\-–—:：~～]+$/g, '').trim();

  // If stripping everything left an empty string, fall back to a lightly trimmed raw title
  if (!cleaned) {
    cleaned = rawTitle.replace(/[｜|]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return cleaned;
}

export function normalizeSeriesKey(title: string): string {
  const cleaned = cleanSeriesTitle(title)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/['’`]/g, '')
    .replace(/[":;,.!?！？。，、\-–—_()（）\[\]【】《》「」~～/\\]/g, ' ')
    .replace(/\b(?:season|s)\s*0?1\b/gi, ' ')
    .replace(/第[一1]季/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || title.toLowerCase().trim();
}
