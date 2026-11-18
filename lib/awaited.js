'use strict';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SEP = /[;&|()\n`]/;
const MAX_IDS = 16;

function awaitedIds(command) {
  if (typeof command !== 'string' || !command.includes('bd-wait')) return [];
  const out = [];
  for (const seg of command.split(SEP)) {
    const words = seg.trim().split(/\s+/);
    const i = words.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (!words[i] || !/(^|\/)bd-wait$/.test(words[i])) continue;
    for (const w of words.slice(i + 1)) {
      const id = w.replace(/^['"]|['"]$/g, '');
      if (ID.test(id) && !id.startsWith('-') && !out.includes(id)) out.push(id);
      if (out.length >= MAX_IDS) return out;
    }
  }
  return out;
}

function fromToolUse(block) {
  if (!block || block.type !== 'tool_use' || block.name !== 'Bash' || !block.input) return [];
  return awaitedIds(block.input.command);
}

module.exports = { awaitedIds, fromToolUse };
