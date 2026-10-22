// Minimal i18next shim for the headless container MCP.
// The vendored localeFormatting.js only reads i18n.resolvedLanguage/language
// (via activeLocale). In a container there is no i18n runtime; a fixed locale
// is correct, because MCP output is machine-facing (dates are ISO, times are
// wall-clock HH:MM) and the human-facing labels this feeds are not on the
// tool path. Keep this the ONLY difference from the app's localeFormatting.js.
const i18n = {
  resolvedLanguage: process.env.DAYGLANCE_LOCALE || 'en',
  language: process.env.DAYGLANCE_LOCALE || 'en',
};
export default i18n;
