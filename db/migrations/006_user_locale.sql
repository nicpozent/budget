-- 006 Per-user language preference (NFR-010).
--
-- The locale is a property of the person, not of the browser they happen to be
-- sitting at: a Finnish controller working from a shared machine in Sweden
-- should get Finnish. So it is stored, not sniffed — the browser's
-- Accept-Language is only the first guess, made once at provisioning.
--
-- Constrained by CHECK rather than by a lookup table. The set is small, closed,
-- and changing it is a code change anyway (a locale without a catalogue would
-- render as English while claiming otherwise), so a table would add a join and
-- no safety.

alter table users
  add column locale text not null default 'en'
    check (locale in ('en', 'sv', 'nb', 'fi', 'da', 'fr'));

comment on column users.locale is
  'UI language (NFR-010). Must have a catalogue in packages/web/src/i18n; a '
  'value here without one would silently render English.';

-- The application updates a user''s own locale; it already holds update on users.
