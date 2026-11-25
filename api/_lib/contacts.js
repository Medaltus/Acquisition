/**
 * api/_lib/contacts.js
 *
 * Shared helpers for contact finding: title ranking, role-email detection, name matching.
 */

/** 1 = founder/CEO, 2 = C-level marketing/growth/digital, 3 = VP/Head, 4 = Director, 5 = Manager, 9 = other. */
export function titleRank(title) {
  const t = String(title || '').toLowerCase();
  const area = /(e-?commerce|digital|growth|marketing|marketplace|amazon|dtc|direct.to.consumer|retail|sales|brand|commercial)/;
  if (/(co-?founder|founder|\bceo\b|chief executive|\bowner\b)/.test(t) || (/\bpresident\b/.test(t) && !/vice[\s-]*president/.test(t))) return 1;
  if (/(\bcmo\b|\bcgo\b|\bcdo\b|\bcco\b|\bcro\b|chief (marketing|growth|digital|commercial|revenue|brand))/.test(t)) return 2;
  if (/(\bvp\b|vice[\s-]*president|\bhead of\b|\bsvp\b|\bevp\b)/.test(t) && area.test(t)) return 3;
  if (/director/.test(t) && area.test(t)) return 4;
  if (/manager|lead/.test(t) && /(e-?commerce|marketplace|amazon|digital)/.test(t)) return 5;
  return 9;
}

const ROLE_LOCAL = /^(info|hello|hi|contact|press|pr|media|wholesale|sales|partner|partners|partnerships|collab|collabs|business|bd|support|care|help|customer|customerservice|cs|team|marketing|retail|orders|admin|office|ops)$/;

/** Split emails on a brand's domain into role addresses (hello@, press@) and personal-looking ones. */
export function classifyEmails(emails, domain) {
  const role = new Set(), personal = new Set();
  for (const raw of emails) {
    const e = String(raw).toLowerCase().replace(/^mailto:/, '').split('?')[0].trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)) continue;
    const [local, host] = e.split('@');
    if (domain && !host.endsWith(domain)) continue;
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(e)) continue;
    (ROLE_LOCAL.test(local) ? role : personal).add(e);
  }
  return { role: [...role], personal: [...personal] };
}

/** Does a personal-looking email plausibly belong to this person? (jane@, jane.doe@, jdoe@, janed@) */
export function emailMatchesName(email, name) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z]/g, '');
  const parts = String(name).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).map(p => p.replace(/[^a-z]/g, '')).filter(Boolean);
  if (!parts.length || !local) return false;
  const [first, last] = [parts[0], parts[parts.length - 1]];
  return [first, first + last, first[0] + last, first + last[0], last + first].some(c => c && c.length > 2 && local === c);
}
