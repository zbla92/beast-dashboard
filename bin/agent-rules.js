#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { accountDirs, writeFileAtomic } = require('./install-hooks');

const START = '<!-- beast-dash agent rules -->';
const END = '<!-- /beast-dash agent rules -->';
const ROOT = path.join(__dirname, '..');
const DOC = 'docs/guide/agent-rules.md';
const USAGE = 'usage: node bin/agent-rules.js --status | --install | --remove | --print | --ask';

const occurrences = (text, mark) => text.split(mark).length - 1;

function rulesBlock(root = ROOT) {
  const doc = fs.readFileSync(path.join(root, DOC), 'utf8');
  const found = doc.match(/^```markdown\n([\s\S]*?)\n```$/m);
  if (!found || !found[1].startsWith(START) || !found[1].endsWith(END)) throw new Error(`${DOC} has no rules block`);
  return found[1];
}

function stateOf(text, rules) {
  const starts = occurrences(text, START);
  const ends = occurrences(text, END);
  if (!starts && !ends) return 'absent';
  const from = text.indexOf(START);
  const to = text.indexOf(END);
  if (starts !== 1 || ends !== 1 || to < from) return 'broken';
  return text.slice(from, to + END.length) === rules ? 'current' : 'outdated';
}

function withRules(text, rules) {
  if (stateOf(text, rules) === 'absent') return `${text}${!text ? '' : text.endsWith('\n') ? '\n' : '\n\n'}${rules}\n`;
  return text.slice(0, text.indexOf(START)) + rules + text.slice(text.indexOf(END) + END.length);
}

function withoutRules(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const before = text.slice(0, text.indexOf(START)).replace(/(\r?\n)+$/, '');
  const after = text.slice(text.indexOf(END) + END.length).replace(/^(\r?\n)+/, '');
  const rest = [before, after].filter(Boolean).join(eol + eol);
  return rest && !rest.endsWith('\n') ? rest + eol : rest;
}

function readTarget(file) {
  try {
    const raw = fs.readFileSync(file);
    const text = raw.toString('utf8');
    return Buffer.from(text).equals(raw) ? { file, text } : { file, error: 'not UTF-8 text' };
  } catch (e) {
    return e.code === 'ENOENT' ? { file, text: '' } : { file, error: e.message };
  }
}

function targets(home, rules, log) {
  const dirs = accountDirs(home).filter(d => fs.existsSync(d));
  const found = dirs.map(d => readTarget(path.join(d, 'CLAUDE.md')));
  for (const t of found) if (t.error) log(`skip ${t.file}: ${t.error}`);
  return found.filter(t => !t.error).map(t => ({ ...t, state: stateOf(t.text, rules) }));
}

function warnBroken(t, log) {
  log(`left alone ${t.file}: the agent rules markers are missing or doubled, fix them by hand`);
}

function save(t, text, done, log) {
  try {
    writeFileAtomic(t.file, text);
    log(`${done} ${t.file}`);
  } catch (e) {
    log(`warning: could not write ${t.file}: ${e.message}`);
  }
}

const verb = t => (t.state === 'absent' ? 'added to' : 'updated in');

function status({ home, rules, log }) {
  for (const t of targets(home, rules, log)) log(`${t.state} ${t.file}`);
}

function install({ home, rules, log }) {
  for (const t of targets(home, rules, log)) {
    if (t.state === 'current') log(`current ${t.file}`);
    else if (t.state === 'broken') warnBroken(t, log);
    else save(t, withRules(t.text, rules), verb(t), log);
  }
}

function remove({ home, rules, log }) {
  for (const t of targets(home, rules, log)) {
    if (t.state === 'broken') warnBroken(t, log);
    else if (t.state !== 'absent') save(t, withoutRules(t.text), 'removed from', log);
  }
}

async function ask({ home, rules, log, prompt }) {
  const all = targets(home, rules, log);
  for (const t of all) if (t.state === 'broken') warnBroken(t, log);
  const pending = all.filter(t => t.state === 'absent' || t.state === 'outdated');
  if (!pending.length) return;
  if (!prompt) {
    for (const t of pending) log(`not ${t.state === 'absent' ? 'added to' : 'updated in'} ${t.file}: see ${DOC}, or run node bin/agent-rules.js --install`);
    return;
  }
  for (const t of pending) {
    const answer = await prompt(`${t.state === 'absent' ? 'Add' : 'Update'} the agent rules (${DOC}) in ${t.file}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) { log(`left alone ${t.file}`); continue; }
    const now = readTarget(t.file);
    if (now.error) { log(`skip ${t.file}: ${now.error}`); continue; }
    const fresh = { ...now, state: stateOf(now.text, rules) };
    if (fresh.state === 'broken') warnBroken(fresh, log);
    else if (fresh.state === 'current') log(`current ${fresh.file}`);
    else save(fresh, withRules(fresh.text, rules), verb(fresh), log);
  }
}

function terminalPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { rl.close(); process.exit(130); });
  const closed = new Promise(resolve => rl.once('close', () => resolve('')));
  const prompt = question => Promise.race([closed, new Promise(resolve => rl.question(question, resolve))]);
  return { prompt, close: () => rl.close() };
}

module.exports = { rulesBlock, stateOf, withRules, withoutRules, status, install, remove, ask, START, END };

async function main() {
  const flag = process.argv[2];
  const base = { home: process.env.HOME, rules: rulesBlock(), log: m => console.log(m) };
  if (flag === '--print') return console.log(base.rules);
  if (flag === '--status') return status(base);
  if (flag === '--install') return install(base);
  if (flag === '--remove') return remove(base);
  if (flag !== '--ask') {
    console.error(USAGE);
    process.exitCode = 2;
    return undefined;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return ask(base);
  const terminal = terminalPrompt();
  try { return await ask({ ...base, prompt: terminal.prompt }); } finally { terminal.close(); }
}

if (require.main === module) {
  main().catch(e => {
    console.error(`agent rules: ${e.message}`);
    process.exitCode = 1;
  });
}
