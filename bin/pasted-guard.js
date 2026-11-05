#!/usr/bin/env node
'use strict';
const { blockedUse } = require('../lib/pasted');

const parsed = (() => { try { return JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch { return null; } })();
const reason = parsed && blockedUse(parsed);
if (reason) { process.stderr.write(reason + '\n'); process.exit(2); }
