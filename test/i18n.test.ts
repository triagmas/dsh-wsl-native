import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTranslator,
  detectLocale,
  format,
  missingTranslations,
  normalizeLocale,
  placeholders,
  resolveLocale,
  translate,
  LOCALES,
} from '../src/i18n/index.js';
import { en } from '../src/i18n/en.js';
import { ru } from '../src/i18n/ru.js';
import { zhCN } from '../src/i18n/zh-CN.js';

test('every locale carries the complete key set with matching placeholders', () => {
  for (const locale of LOCALES) {
    assert.deepEqual(missingTranslations(locale), [], `${locale} has missing or mistranslated keys`);
  }
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  assert.deepEqual(Object.keys(zhCN).sort(), Object.keys(en).sort());
});

test('locale normalization accepts regional and script variants', () => {
  assert.equal(normalizeLocale('ru-RU'), 'ru');
  assert.equal(normalizeLocale('ru_RU.UTF-8'), 'ru');
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh-CN');
  assert.equal(normalizeLocale('zh_CN'), 'zh-CN');
  assert.equal(normalizeLocale('de-DE'), null);
  assert.equal(normalizeLocale(''), null);
  assert.equal(normalizeLocale(undefined), null);
});

test('language detection prefers explicit configuration, then the environment', () => {
  assert.equal(detectLocale({ DSH_WSL_LOCALE: 'ru-RU', LANG: 'en_US.UTF-8' }), 'ru');
  assert.equal(detectLocale({ LANGUAGE: 'de:zh-CN:ru', LANG: 'en_US.UTF-8' }), 'zh-CN');
  assert.equal(detectLocale({ LC_ALL: 'ru_RU.UTF-8' }), 'ru');
  assert.equal(detectLocale({}, () => null), 'en');
});

test('an explicit supported preference wins over detection', () => {
  assert.equal(resolveLocale('zh-CN', 'ru'), 'zh-CN');
  assert.equal(resolveLocale('fr-FR', 'ru'), 'ru');
  assert.equal(resolveLocale(undefined, 'en'), 'en');
});

test('placeholders are interpolated and unknown names stay verbatim', () => {
  const template = 'Hello {name}, {missing}';
  assert.deepEqual(placeholders(template), ['missing', 'name']);
  assert.equal(format(template, { name: 'мир' }), 'Hello мир, {missing}');
  assert.equal(format(template), template);
});

test('translators resolve each locale and keep placeholders intact', () => {
  const english = createTranslator('en');
  const russian = createTranslator('ru');
  assert.equal(english.t('cli.grantAdded', { id: 'abc' }), 'Grant created: abc');
  assert.match(russian.t('cli.grantAdded', { id: 'abc' }), /abc/);
  // Mode names keep the English product name in brackets but are localized.
  assert.equal(english.t('permissions.mode.protected'), 'Protected');
  assert.match(russian.t('permissions.mode.protected'), /^[А-Яа-яЁё\s]+\s\(Protected\)$/);
  assert.match(translate('zh-CN', 'permissions.mode.trusted'), /^受信任/);
  assert.notEqual(
    russian.t('permissions.mode.protected.description'),
    english.t('permissions.mode.protected.description'),
  );

});

test('the permission panel copy exists in every locale', () => {
  for (const locale of LOCALES) {
    const translator = createTranslator(locale);
    assert.match(translator.t('ui.permissions.fullAccessWarning'), /\S/);
    assert.match(translator.t('permissions.denied.stateFile'), /\S/);
  }
});
