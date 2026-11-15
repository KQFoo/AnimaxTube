export interface SeedChannelSpec {
  name: string;
  handle?: string;
  channelId?: string;
  category: 'anime' | 'donghua' | 'studio';
  regionFocus: string;
  defaultSubLanguages: Array<'en' | 'zh-Hant' | 'zh-Hans'>;
  notes?: string;
}

/**
 * Curated master registry of known official/licensed YouTube channels
 * uploading free anime & donghua series with English and/or Chinese subtitles.
 * `discover-channels.ts` resolves each handle/ID via YouTube Data API v3 AND
 * runs live EN + ZH search queries to uncover any additional channels.
 */
export const SEED_CHANNELS: SeedChannelSpec[] = [
  // --- Muse Communication Network ---
  {
    name: 'Muse Asia',
    handle: '@MuseAsia',
    channelId: 'UCGbshtvS9t-8CW11W7TooQg',
    category: 'anime',
    regionFocus: 'South & Southeast Asia',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Muse木棉花-TW',
    handle: '@MuseTW',
    category: 'anime',
    regionFocus: 'Taiwan / HK / Macau',
    defaultSubLanguages: ['zh-Hant'],
  },
  {
    name: 'Muse木棉花-HK',
    handle: '@MuseHK',
    category: 'anime',
    regionFocus: 'Hong Kong / Macau',
    defaultSubLanguages: ['zh-Hant'],
  },
  {
    name: 'Muse木棉花-闔家歡',
    channelId: 'UCCPYSMEnbeepGM7RU6qxyUA',
    category: 'anime',
    regionFocus: 'Taiwan / Family Anime',
    defaultSubLanguages: ['zh-Hant'],
  },
  {
    name: 'Muse木棉花-精選動畫',
    channelId: 'UCaNJ7uQDxAHXFaRcV8d5eBA',
    category: 'anime',
    regionFocus: 'Taiwan / HK',
    defaultSubLanguages: ['zh-Hant'],
  },
  {
    name: 'Muse木棉花-亚洲中文台',
    channelId: 'UCZjhrVS3D4zYiNlTbNqPTWQ',
    category: 'anime',
    regionFocus: 'Asia (Simplified & Traditional Chinese)',
    defaultSubLanguages: ['zh-Hans', 'zh-Hant'],
  },
  {
    name: 'Muse Asia - Best Anime Collection',
    channelId: 'UCP8E_gJhRMApuQYOQ21MkLA',
    category: 'anime',
    regionFocus: 'South & Southeast Asia',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Muse Malaysia',
    handle: '@MuseMalaysia',
    category: 'anime',
    regionFocus: 'Malaysia / Brunei',
    defaultSubLanguages: ['en', 'zh-Hans'],
  },
  {
    name: 'Muse Philippines',
    handle: '@MusePhilippines',
    category: 'anime',
    regionFocus: 'Philippines',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Muse India',
    handle: '@MuseIndiaChannel',
    category: 'anime',
    regionFocus: 'India / South Asia',
    defaultSubLanguages: ['en'],
  },

  // --- Medialink / Ani-One / Ani-Mi Network ---
  {
    name: 'Ani-One Asia',
    handle: '@AniOneAsia',
    category: 'anime',
    regionFocus: 'Asia-Pacific',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Ani-One中文官方動畫頻道',
    handle: '@AniOneAnime',
    category: 'anime',
    regionFocus: 'Taiwan / HK / Macau',
    defaultSubLanguages: ['zh-Hant'],
  },
  {
    name: 'Ani-One Philippines',
    handle: '@AniOnePhilippines',
    category: 'anime',
    regionFocus: 'Philippines',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Ani-One India',
    channelId: 'UC67pLBZ_z4Gd46t6mW7uHjA',
    category: 'anime',
    regionFocus: 'India / South Asia',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Ani-Mi Asia',
    handle: '@AnimiforAsia',
    category: 'anime',
    regionFocus: 'Asia-Pacific',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Ani-Mi Anime',
    handle: '@AnimiforAnime',
    category: 'anime',
    regionFocus: 'Taiwan / HK / Asia',
    defaultSubLanguages: ['zh-Hant'],
  },

  // --- Other Official Anime Licensors & Publishers ---
  {
    name: 'Tropics Anime Asia',
    handle: '@TropicsAnimeAsia',
    category: 'anime',
    regionFocus: 'Asia',
    defaultSubLanguages: ['en', 'zh-Hant'],
  },
  {
    name: "It's Anime powered by REMOW",
    handle: '@ItsAnimeJP',
    category: 'anime',
    regionFocus: 'Global',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'GundamInfo',
    handle: '@GundamInfo',
    category: 'studio',
    regionFocus: 'Global',
    defaultSubLanguages: ['en', 'zh-Hant', 'zh-Hans'],
  },
  {
    name: 'Anime! on TMS Official Channel',
    handle: '@AnimeonTMSOfficialChannel',
    category: 'studio',
    regionFocus: 'Global',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'RetroCrush',
    handle: '@RetroCrush',
    category: 'anime',
    regionFocus: 'North America / Global',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Nozomi Entertainment',
    handle: '@nozomient',
    category: 'anime',
    regionFocus: 'North America / Global',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Crunchyroll',
    handle: '@crunchyroll',
    category: 'anime',
    regionFocus: 'Global (select free premiere/series playlists)',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Crunchyroll Dubs',
    channelId: 'UCVi2lI40LetxLBKn-rtWC3A',
    category: 'anime',
    regionFocus: 'Global (English Dubs / Free Episodes)',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'AnimeLog',
    handle: '@AnimeLog',
    category: 'anime',
    regionFocus: 'Global / Japan',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Pokémon Asia ENG',
    handle: '@PokemonAsiaENG',
    category: 'studio',
    regionFocus: 'Asia',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Pokémon Asia 中文',
    handle: '@PokemonAsiaOfficial',
    category: 'studio',
    regionFocus: 'Taiwan / HK',
    defaultSubLanguages: ['zh-Hant'],
  },
  {
    name: 'CARDFIGHT!! VANGUARD',
    handle: '@CARDFIGHTVanguard',
    category: 'studio',
    regionFocus: 'Global',
    defaultSubLanguages: ['en'],
  },
  {
    name: 'Bandai Spirits',
    handle: '@BANDAISPIRITS',
    category: 'studio',
    regionFocus: 'Global',
    defaultSubLanguages: ['en'],
  },

  // --- Official Chinese Donghua & Multi-sub Animation Channels ---
  {
    name: 'MadeByBilibili',
    handle: '@MadeByBilibili',
    category: 'donghua',
    regionFocus: 'Global',
    defaultSubLanguages: ['en', 'zh-Hans', 'zh-Hant'],
  },
  {
    name: 'Tencent Video Animation',
    handle: '@TencentVideoAnimation',
    category: 'donghua',
    regionFocus: 'Global',
    defaultSubLanguages: ['en', 'zh-Hans'],
  },
  {
    name: 'YOUKU Animation',
    handle: '@YOUKUAnimation',
    category: 'donghua',
    regionFocus: 'Global',
    defaultSubLanguages: ['en', 'zh-Hans'],
  },
  {
    name: 'iQIYI Anime Asia',
    channelId: 'UCVQvZ-qsSF2UWzFhmCv079A',
    category: 'donghua',
    regionFocus: 'Global / Asia',
    defaultSubLanguages: ['en', 'zh-Hans', 'zh-Hant'],
  },
];

export const DISCOVERY_SEARCH_QUERIES: Array<{
  query: string;
  langHint: 'en' | 'zh-Hant' | 'zh-Hans';
}> = [
  { query: 'anime full episode eng sub official', langHint: 'en' },
  { query: 'free anime series full episodes playlist eng sub', langHint: 'en' },
  { query: '正版動畫 線上看 全集 繁中', langHint: 'zh-Hant' },
  { query: '動畫 全集 中文字幕 官方頻道', langHint: 'zh-Hant' },
  { query: 'donghua full episode eng sub official', langHint: 'en' },
  { query: '動畫馬拉松 免費看 官方', langHint: 'zh-Hant' },
];
