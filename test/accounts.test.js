'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { companyDir, companyDirIn, accountOf } = require('../lib/accounts');

test('the company folder defaults to ~/.claude-company and follows BD_COMPANY_DIR', () => {
  assert.strictEqual(companyDir({ HOME: '/h' }), '/h/.claude-company');
  assert.strictEqual(companyDir({ HOME: '/h', BD_COMPANY_DIR: '~/.claude-work' }), '/h/.claude-work');
  assert.strictEqual(companyDir({ HOME: '/h', BD_COMPANY_DIR: '/abs/work' }), '/abs/work');
});

test('companyDirIn honours BD_COMPANY_DIR only for the real home', () => {
  const env = { HOME: '/h', BD_COMPANY_DIR: '/abs/work' };
  assert.strictEqual(companyDirIn('/h', env), '/abs/work');
  assert.strictEqual(companyDirIn('/tmp/other', env), path.join('/tmp/other', '.claude-company'));
  assert.strictEqual(companyDirIn('/h', { HOME: '/h' }), '/h/.claude-company');
});

test('accountOf treats every folder but ~/.claude as the second login', () => {
  assert.strictEqual(accountOf(''), 'personal');
  assert.strictEqual(accountOf('/h/.claude/'), 'personal');
  assert.strictEqual(accountOf('/h/.claude-company'), 'company');
  assert.strictEqual(accountOf('/h/.claude-work'), 'company');
});

test('companyDirIn treats a home with a trailing slash as the same home', () => {
  assert.strictEqual(companyDirIn('/h/', { HOME: '/h', BD_COMPANY_DIR: '/abs/work' }), '/abs/work');
});
