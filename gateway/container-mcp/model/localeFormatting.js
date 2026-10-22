import i18n from './i18next-shim.js';

export const activeLocale = () => i18n.resolvedLanguage || i18n.language || 'en';

export const defaultUse24HourClock = (language = activeLocale()) =>
  ['h23', 'h24'].includes(new Intl.DateTimeFormat(language, { hour: 'numeric' }).resolvedOptions().hourCycle);

export const defaultWeekStartDay = (language = activeLocale()) => {
  const locale = new Intl.Locale(language);
  // Chromium exposes getWeekInfo(); Safari exposes the earlier weekInfo getter.
  const weekInfo = locale.getWeekInfo?.() ?? locale.weekInfo;
  return weekInfo ? weekInfo.firstDay % 7 : 0;
};

export const formatLocalizedDate = (date, options, language = activeLocale()) =>
  new Intl.DateTimeFormat(language, options).format(date);

// A regional BCP-47 tag ("uk-UA") for APIs like SpeechRecognition that
// don't reliably accept a bare language subtag. `maximize()` also adds a
// script subtag ("uk-Cyrl-UA"), which those APIs don't expect, so drop it.
export const speechRecognitionLocale = (language = activeLocale(), reported = globalThis.navigator?.language) => {
  const app = new Intl.Locale(language);
  // A bare app tag ("en", "uk") expresses no regional preference, so the
  // browser's own tag refines it where the two agree on the language. A tag
  // that already names a region ("pt-BR", "zh-CN") is an explicit choice.
  if (!app.region && reported) {
    try {
      const nav = new Intl.Locale(reported);
      if (nav.language === app.language && nav.region) return `${nav.language}-${nav.region}`;
    } catch { /* unparsable navigator tag: fall through */ }
  }
  const max = app.maximize();
  return max.region ? `${max.language}-${max.region}` : max.language;
};

export const localizedWeekdays = (width = 'short', language = activeLocale()) => {
  const formatter = new Intl.DateTimeFormat(language, { weekday: width, timeZone: 'UTC' });
  const sunday = Date.UTC(2024, 0, 7);
  return Array.from({ length: 7 }, (_, day) => formatter.format(new Date(sunday + day * 86400000)));
};

// "a, b and c" in whatever conjunction the language uses — a locale-aware
// substitute for `list.join(' and ')`.
export const localizedList = (items, language = activeLocale()) =>
  new Intl.ListFormat(language, { type: 'conjunction' }).format(items);
