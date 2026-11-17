'use strict';

const TABLE = [
  ['security', 'security secure sec auth pentest vuln audit infosec owasp'],
  ['legal', 'legal law lawyer contract gdpr compliance policy terms privacy'],
  ['money', 'money finance financial invoice billing budget accounting accountant tax payroll expense pay payment price pricing'],
  ['translate', 'translate translator translation i18n l10n localize localization language'],
  ['review', 'review reviewer critic critique proofread feedback pr'],
  ['test', 'test tester testing qa e2e unit'],
  ['bug', 'bug debug debugger triage fix fixer crash'],
  ['deploy', 'deploy deployer deployment release ship ci cd devops ops infra k8s kubernetes docker'],
  ['database', 'database db sql postgres postgresql mysql sqlite mongo redis query queries'],
  ['calendar', 'calendar schedule scheduler meeting agenda booking plan planner'],
  ['support', 'support helpdesk ticket customer care faq'],
  ['mail', 'mail email inbox newsletter outreach'],
  ['chat', 'chat slack discord telegram sms message messenger reply replies social'],
  ['design', 'design designer ui ux figma css style brand'],
  ['image', 'image photo picture art illustration logo icon video media'],
  ['chart', 'chart report reporting metrics kpi dashboard analytics stats insight'],
  ['data', 'data etl pipeline csv excel sheet spreadsheet scrape scraper import export dataset'],
  ['search', 'search research researcher find finder lookup scout web'],
  ['docs', 'docs doc documentation wiki readme notes knowledge manual guide'],
  ['write', 'write writer writing copy copywriter blog post editor author content draft'],
  ['cloud', 'cloud aws gcp azure server hosting dns'],
  ['terminal', 'terminal shell bash cli script sysadmin linux'],
  ['code', 'code coder coding dev developer engineer programmer frontend backend api refactor js python rust typescript'],
  ['robot', 'bot robot assistant agent helper']
].map(([key, words]) => ({ key, words: new Set(words.split(' ')) }));

const KEYS = TABLE.map(r => r.key);
const PALETTE = ['#4f7cff', '#8b5cf6', '#d946ef', '#ec4899', '#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e', '#14b8a6', '#06b6d4', '#64748b'];
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const KEY_SHAPE = /^[a-z][a-z0-9-]*$/;

function fnv1a32(text) {
  const h = [...Buffer.from(String(text), 'utf8')].reduce((acc, b) => Math.imul(acc ^ b, 0x01000193) >>> 0, 0x811c9dc5);
  return h >>> 0;
}

function keyFromText(text) {
  const toks = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const hit = TABLE.find(r => toks.some(t => r.words.has(t) || (t.endsWith('s') && r.words.has(t.slice(0, -1)))));
  return hit ? hit.key : null;
}

function iconFor({ name, title, icon, color } = {}) {
  const stored = typeof icon === 'string' ? icon : '';
  const tint = typeof color === 'string' && COLOR.test(color) ? color : PALETTE[fnv1a32(name === undefined || name === null ? '' : name) % PALETTE.length];
  if (KEYS.includes(stored)) return { key: stored, color: tint, glyph: null };
  const key = keyFromText(name) || keyFromText(title) || 'robot';
  const auto = stored === '' || stored === 'auto' || stored === '◆' || KEY_SHAPE.test(stored);
  return { key, color: tint, glyph: auto ? null : stored };
}

module.exports = { iconFor, fnv1a32, KEYS, PALETTE };
