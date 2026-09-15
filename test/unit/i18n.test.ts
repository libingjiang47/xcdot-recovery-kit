import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES, normalizeLocale, setLocale, t, translations } from '../../web/i18n.js';

describe('terminal frontend translations', () => {
  it('has the same key set for every supported locale', () => {
    expect(SUPPORTED_LOCALES).toHaveLength(5);
    const englishKeys = Object.keys(translations.en).sort();
    for (const locale of SUPPORTED_LOCALES)
      expect(Object.keys(translations[locale]).sort()).toEqual(englishKeys);
  });

  it('resolves language families and interpolates translated text', () => {
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(normalizeLocale('ja-JP')).toBe('ja');
    expect(normalizeLocale('en-US')).toBe('en');
    setLocale('en', false);
    expect(t('top.lede', { block: '16,796,696' })).toContain('16,796,696');
  });
});
