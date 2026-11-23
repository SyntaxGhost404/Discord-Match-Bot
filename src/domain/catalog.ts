// Fixed vocabularies for profiles. Keys are stored in the database and must
// never change; labels and emoji can be edited freely.

export interface CatalogItem {
  key: string;
  label: string;
  emoji: string;
}

export type Gender = 'woman' | 'man' | 'nonbinary' | 'unspecified';

export const GENDERS: ReadonlyArray<CatalogItem & { key: Gender; plural: string }> = [
  { key: 'woman', label: 'Woman', plural: 'Women', emoji: '👩' },
  { key: 'man', label: 'Man', plural: 'Men', emoji: '👨' },
  { key: 'nonbinary', label: 'Non-binary', plural: 'Non-binary people', emoji: '🧑' },
  { key: 'unspecified', label: 'Prefer not to say', plural: 'Everyone else', emoji: '🙂' },
];

export const LOOKING_FOR: readonly CatalogItem[] = [
  { key: 'friends', label: 'New friends', emoji: '🤝' },
  { key: 'chat', label: 'Someone to talk to', emoji: '💬' },
  { key: 'gaming', label: 'Gaming buddies', emoji: '🎮' },
  { key: 'study', label: 'Study buddies', emoji: '📚' },
  { key: 'language', label: 'Language exchange', emoji: '🗣️' },
  { key: 'voice', label: 'Voice calls & hangouts', emoji: '🎧' },
  { key: 'creative', label: 'Creative collabs', emoji: '🎨' },
];

export const INTERESTS: readonly CatalogItem[] = [
  { key: 'gaming', label: 'Gaming', emoji: '🎮' },
  { key: 'anime', label: 'Anime & manga', emoji: '🎌' },
  { key: 'music', label: 'Music', emoji: '🎵' },
  { key: 'movies', label: 'Movies & TV', emoji: '🎬' },
  { key: 'books', label: 'Books', emoji: '📚' },
  { key: 'writing', label: 'Writing', emoji: '✍️' },
  { key: 'art', label: 'Art & design', emoji: '🎨' },
  { key: 'photography', label: 'Photography', emoji: '📸' },
  { key: 'coding', label: 'Programming', emoji: '💻' },
  { key: 'tech', label: 'Tech & AI', emoji: '🤖' },
  { key: 'science', label: 'Science & space', emoji: '🔭' },
  { key: 'sports', label: 'Sports', emoji: '⚽' },
  { key: 'fitness', label: 'Fitness', emoji: '🏋️' },
  { key: 'outdoors', label: 'Nature & outdoors', emoji: '🏕️' },
  { key: 'travel', label: 'Travel', emoji: '✈️' },
  { key: 'food', label: 'Food & cooking', emoji: '🍳' },
  { key: 'fashion', label: 'Fashion', emoji: '👗' },
  { key: 'pets', label: 'Animals & pets', emoji: '🐾' },
  { key: 'boardgames', label: 'Board games & TTRPGs', emoji: '🎲' },
  { key: 'memes', label: 'Memes', emoji: '😂' },
  { key: 'streaming', label: 'Streaming & content', emoji: '📺' },
  { key: 'wellness', label: 'Wellness & mindfulness', emoji: '🧘' },
  { key: 'cultures', label: 'Languages & cultures', emoji: '🌍' },
  { key: 'cars', label: 'Cars & motorsport', emoji: '🏎️' },
  { key: 'podcasts', label: 'Podcasts', emoji: '🎙️' },
];

export const LANGUAGES: readonly CatalogItem[] = [
  { key: 'en', label: 'English', emoji: '🇬🇧' },
  { key: 'es', label: 'Español', emoji: '🇪🇸' },
  { key: 'pt', label: 'Português', emoji: '🇧🇷' },
  { key: 'fr', label: 'Français', emoji: '🇫🇷' },
  { key: 'de', label: 'Deutsch', emoji: '🇩🇪' },
  { key: 'it', label: 'Italiano', emoji: '🇮🇹' },
  { key: 'nl', label: 'Nederlands', emoji: '🇳🇱' },
  { key: 'pl', label: 'Polski', emoji: '🇵🇱' },
  { key: 'ru', label: 'Русский', emoji: '🗣️' },
  { key: 'uk', label: 'Українська', emoji: '🇺🇦' },
  { key: 'tr', label: 'Türkçe', emoji: '🇹🇷' },
  { key: 'ar', label: 'العربية', emoji: '🗣️' },
  { key: 'fa', label: 'فارسی', emoji: '🗣️' },
  { key: 'hi', label: 'हिन्दी', emoji: '🇮🇳' },
  { key: 'bn', label: 'বাংলা', emoji: '🇧🇩' },
  { key: 'ur', label: 'اردو', emoji: '🇵🇰' },
  { key: 'id', label: 'Bahasa Indonesia', emoji: '🇮🇩' },
  { key: 'ms', label: 'Bahasa Melayu', emoji: '🇲🇾' },
  { key: 'tl', label: 'Filipino', emoji: '🇵🇭' },
  { key: 'vi', label: 'Tiếng Việt', emoji: '🇻🇳' },
  { key: 'th', label: 'ไทย', emoji: '🇹🇭' },
  { key: 'zh', label: '中文', emoji: '🇨🇳' },
  { key: 'ja', label: '日本語', emoji: '🇯🇵' },
  { key: 'ko', label: '한국어', emoji: '🇰🇷' },
  { key: 'other', label: 'Other language', emoji: '🌐' },
];

export const REPORT_REASONS: readonly CatalogItem[] = [
  { key: 'harassment', label: 'Harassment or bullying', emoji: '😠' },
  { key: 'sexual', label: 'Sexual or inappropriate content', emoji: '🔞' },
  { key: 'spam', label: 'Spam, scam or advertising', emoji: '📢' },
  { key: 'hate', label: 'Hate speech or threats', emoji: '⚠️' },
  { key: 'age', label: 'Lying about age / underage', emoji: '🎂' },
  { key: 'fake', label: 'Fake profile or impersonation', emoji: '🎭' },
  { key: 'selfharm', label: 'Self-harm or safety concern', emoji: '🆘' },
  { key: 'other', label: 'Something else', emoji: '📝' },
];

export function findItem<T extends CatalogItem>(list: readonly T[], key: string): T | undefined {
  return list.find((item) => item.key === key);
}

/** Keeps only known keys, without duplicates, in catalog order. */
export function normalizeKeys(list: readonly CatalogItem[], keys: readonly string[], max = Infinity): string[] {
  const wanted = new Set(keys);
  return list.filter((item) => wanted.has(item.key)).map((item) => item.key).slice(0, max);
}

export function isGender(value: unknown): value is Gender {
  return typeof value === 'string' && GENDERS.some((g) => g.key === value);
}

/** Maps a Discord locale (e.g. "pt-BR") to one of our language keys. */
export function languageFromLocale(locale: string | undefined): string | null {
  if (!locale) return null;
  const base = locale.toLowerCase().split('-')[0] ?? '';
  return LANGUAGES.some((l) => l.key === base) ? base : null;
}

export function describeKeys(list: readonly CatalogItem[], keys: readonly string[], highlight: ReadonlySet<string> = new Set()): string {
  return keys
    .map((key) => findItem(list, key))
    .filter((item): item is CatalogItem => Boolean(item))
    .map((item) => (highlight.has(item.key) ? `**${item.emoji} ${item.label}**` : `${item.emoji} ${item.label}`))
    .join(' · ');
}
