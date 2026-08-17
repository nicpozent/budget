/**
 * String catalogue and locale resolution (NFR-010).
 *
 * English is the source language; five others are typed against it, so a key
 * added to `en.ts` without a translation is a compile error in five files
 * rather than a silent English fallback nobody notices.
 *
 * Deliberately not a translation library. What one adds over this is plural
 * rules, gender and message-format parsing; none applies to a budget grid whose
 * variable content is numbers and dates, and all of which `Intl` already handles
 * in `format.ts`. It also puts a dependency inside the trust boundary, which
 * ADR-0004 sets a high bar for.
 *
 * **The locale is a property of the person, not the browser.** It is stored on
 * the user record and applied after sign-in. `navigator.language` is only the
 * first guess, made once when an account is provisioned — a Finnish controller
 * working from a shared machine in Sweden should get Finnish.
 *
 * Interpolation takes named parameters and never concatenates fragments: word
 * order differs between languages, so "{count} of {total}" must stay one
 * translatable unit.
 */

import { EN } from './en.ts';
import { SV } from './sv.ts';
import { NB } from './nb.ts';
import { DA } from './da.ts';
import { FI } from './fi.ts';
import { FR } from './fr.ts';

export type MessageKey = keyof typeof EN;

/** A complete catalogue. A partial translation does not type-check. */
export type Catalogue = Readonly<Record<MessageKey, string>>;

export const LOCALES = ['en', 'sv', 'nb', 'da', 'fi', 'fr'] as const;
export type Locale = (typeof LOCALES)[number];

const CATALOGUES: Readonly<Record<Locale, Catalogue>> = Object.freeze({
  en: EN, sv: SV, nb: NB, da: DA, fi: FI, fr: FR,
});

/**
 * What each language calls itself. Never translated: a language picker that
 * says "Swedish" to someone who only reads Swedish is useless.
 */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = Object.freeze({
  en: 'English',
  sv: 'Svenska',
  nb: 'Norsk bokmål',
  da: 'Dansk',
  fi: 'Suomi',
  fr: 'Français',
});

/**
 * BCP-47 tag for `Intl`. The catalogue key is a language; number and date
 * formatting is regional, and these are the regions this group operates in.
 */
const INTL_TAG: Readonly<Record<Locale, string>> = Object.freeze({
  en: 'en-GB', sv: 'sv-SE', nb: 'nb-NO', da: 'da-DK', fi: 'fi-FI', fr: 'fr-FR',
});

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

let activeLocale: Locale = 'en';
let active: Catalogue = EN;

/**
 * Set the active locale. Called once after `/api/me` returns the stored
 * preference, and again when the user changes it.
 *
 * Also updates `<html lang>`, which is WCAG 3.1.1 and is what tells a screen
 * reader which voice to use — a Swedish page announced with an English
 * synthesiser is close to unintelligible.
 */
export function setLocale(locale: Locale): void {
  activeLocale = locale;
  active = CATALOGUES[locale];
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

export function currentLocale(): Locale {
  return activeLocale;
}

/** The tag `Intl` should use for the active locale. */
export function intlTag(): string {
  return INTL_TAG[activeLocale];
}

/** First guess for a new account, from the browser. Falls back to English. */
export function guessLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en';
  for (const candidate of navigator.languages ?? [navigator.language]) {
    const language = candidate?.split('-')[0]?.toLowerCase();
    // Norwegian has three tags in the wild; all of them mean this catalogue.
    const normalised = language === 'no' || language === 'nn' ? 'nb' : language;
    if (isLocale(normalised)) return normalised;
  }
  return 'en';
}

/**
 * Look up a message, substituting `{name}` placeholders.
 *
 * Values are substituted as-is; React escapes them on render, and this must
 * never be used to build HTML. A placeholder with no matching parameter is left
 * in place rather than blanked, so the gap is visible in review instead of
 * producing a sentence with a hole in it.
 */
export function t(key: MessageKey, params?: Readonly<Record<string, string | number>>): string {
  const template = active[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
