'use strict';

// Pulls e-mail addresses out of pasted text. One pure function shared by the browser (team member and user
// paste fields) and the server (POST /api/teams/:id/members, POST /api/users), so both sides read a paste the
// same way. No dependencies, no DOM.
//
//   OCEmailList.parse(text)  ->  { emails, invalid, found, duplicates }
//     emails      valid addresses, lower case, without duplicates, in the order of appearance
//     invalid     pieces that look like an address (contain "@") but are not valid, or lines without any address
//                 (header rows such as "Name; E-Mail" are skipped), without duplicates
//     found       number of addresses in the text, duplicates included
//     duplicates  found minus emails.length
//   OCEmailList.isValid(address)   strict check of a single, already trimmed address
//   OCEmailList.classify(parsed, existing)  ->  { fresh, already }  (existing: array or Set of lower case addresses)
//
// Understood: one address per line, separated by comma, semicolon, tab, space or a mix ("Excel" columns and
// rows, CSV with quotes and header row), "Name <mail@example.com>" and "mail@example.com (Name)" as Outlook,
// Gmail and Apple Mail copy them, "mailto:" prefixes, angle brackets and quotes around a bare address.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.OCEmailList = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  const MAX_ADDRESS_LENGTH = 254;
  const MAX_LOCAL_LENGTH = 64;
  const MAX_INVALID_LENGTH = 120;

  const LOCAL = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
  const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
  const TLD = /^(?:\p{L}{2,}|xn--[a-z0-9-]{2,59})$/u;
  const HEADER_WORDS = new Set([
    'name', 'names', 'vorname', 'nachname', 'first', 'last', 'firstname', 'lastname', 'fullname', 'full',
    'email', 'e-mail', 'mail', 'emails', 'e-mails', 'adresse', 'adressen', 'address', 'addresses', 'emailadresse',
    'email-adresse', 'e-mail-adresse', 'e-mail-adressen', 'teilnehmer', 'teilnehmende', 'person', 'personen',
    'nombre', 'correo', 'apellido', 'participant', 'participants', 'and', 'und', 'y', 'of', 'von', 'de'
  ]);

  function isValid(value) {
    if (typeof value !== 'string') return false;
    const email = value.trim().toLowerCase();
    if ([...email].length > MAX_ADDRESS_LENGTH) return false;
    const at = email.indexOf('@');
    if (at <= 0 || at !== email.lastIndexOf('@')) return false;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    if ([...local].length > MAX_LOCAL_LENGTH || !LOCAL.test(local)) return false;
    const labels = domain.split('.');
    if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return false;
    return TLD.test(labels[labels.length - 1]);
  }

  // Removes characters a paste wraps around an address: quotes, brackets, a trailing dot or colon.
  function clean(token) {
    let out = String(token).trim();
    out = out.replace(/^mailto:/i, '');
    for (;;) {
      const before = out;
      out = out
        .replace(/^[\s"'`<([{«»‹›„“”‘’]+/u, '')
        .replace(/[\s"'`>)\]}«»‹›„“”‘’.:!?]+$/u, '');
      if (out === before) break;
    }
    return out.replace(/^mailto:/i, '');
  }

  // The heading row of a table: only words like Name / E-Mail, or - on the first line - any columns of which one is
  // the address column.
  function isHeaderLine(line, first) {
    if (first && /(?:^|[\s,;|\t"'])(?:e-?mails?|mail|adressen?|address(?:es)?|correo)(?:[\s,;|\t"':]|$)/iu.test(line)) return true;
    const words = line
      .toLowerCase()
      .split(/[\s,;|\t/()]+/u)
      .map((word) => word.replace(/^["'`]+|["'`:]+$/gu, ''))
      .filter(Boolean);
    return words.length > 0 && words.every((word) => HEADER_WORDS.has(word));
  }

  function shorten(text) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    const chars = [...flat];
    return chars.length > MAX_INVALID_LENGTH ? `${chars.slice(0, MAX_INVALID_LENGTH - 1).join('')}…` : flat;
  }

  function parse(input) {
    const emails = [];
    const seen = new Set();
    const invalid = [];
    const invalidSeen = new Set();
    let found = 0;

    const addInvalid = (piece) => {
      const text = shorten(piece);
      if (!text) return;
      const key = text.toLowerCase();
      if (invalidSeen.has(key)) return;
      invalidSeen.add(key);
      invalid.push(text);
    };
    const addEmail = (raw) => {
      const email = raw.trim().toLowerCase();
      found += 1;
      if (seen.has(email)) return;
      seen.add(email);
      emails.push(email);
    };

    const text = typeof input === 'string' ? input : Array.isArray(input) ? input.filter((part) => typeof part === 'string').join('\n') : '';
    const lines = text
      .replace(/\u00a0|\u2007|\u202f/g, ' ')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .split(/\r\n|[\n\r\u2028\u2029]/u);

    let firstLine = true;
    for (const line of lines) {
      if (!line.trim()) continue;
      const isFirst = firstLine;
      firstLine = false;
      let rest = line;
      let hit = false;

      // "Name <mail@example.com>": the address in angle brackets wins, the display name is dropped.
      rest = rest.replace(/<\s*(?:mailto:)?([^<>\s,;"]*@[^<>\s,;"]*)\s*>/giu, (_match, candidate) => {
        hit = true;
        const value = clean(candidate);
        if (isValid(value)) addEmail(value);
        else addInvalid(value || candidate);
        return ' ; ';
      });

      // Everything else: split into cells and words, and keep the ones with an "@".
      for (const token of rest.split(/[\s,;|\t]+/u)) {
        if (!token.includes('@')) continue;
        hit = true;
        const value = clean(token);
        if (isValid(value)) addEmail(value);
        else addInvalid(value || token);
      }

      // A line without any address is noise (a heading, a name) unless it stands alone: report it, but do not
      // count header rows of a table.
      if (!hit && !isHeaderLine(line, isFirst)) addInvalid(line);
    }

    return { emails, invalid, found, duplicates: found - emails.length };
  }

  function classify(parsed, existing) {
    const known = existing instanceof Set ? existing : new Set((existing || []).map((email) => String(email).toLowerCase()));
    const fresh = [];
    const already = [];
    for (const email of (parsed && parsed.emails) || []) (known.has(email) ? already : fresh).push(email);
    return { fresh, already };
  }

  return { parse, isValid, classify, MAX_ADDRESS_LENGTH };
});
