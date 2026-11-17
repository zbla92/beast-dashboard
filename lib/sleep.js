'use strict';
// "Sleep" button: suspend the beast to RAM from the dashboard and set the RTC alarm so it wakes itself at 07:00 on the
// next weekday (Mon-Fri). Nothing suspends it automatically — this only ever runs when the user presses the button.
// Wake-on-LAN is not an option (WiFi only), the motherboard's RTC alarm needs no network.
const fs = require('fs');
const { run } = require('./util');

const WAKE_HOUR = 7, WAKE_MIN = 0;     // local time
const WEEKDAYS = new Set([1, 2, 3, 4, 5]);
const MIN_AHEAD = 10 * 60000;          // an alarm closer than this is skipped to the next weekday (suspend + resume would race it)
const ALARM = '/sys/class/rtc/rtc0/wakealarm';
const MAX_DRIFT = 120;               // seconds the RTC may differ from the system clock

// next Mon-Fri WAKE_HOUR:WAKE_MIN that is at least MIN_AHEAD in the future
function nextWake(now = new Date()) {
  const d = new Date(now); d.setHours(WAKE_HOUR, WAKE_MIN, 0, 0);
  for (let i = 0; i < 9; i++, d.setDate(d.getDate() + 1), d.setHours(WAKE_HOUR, WAKE_MIN, 0, 0)) {
    if (WEEKDAYS.has(d.getDay()) && d - now >= MIN_AHEAD) return new Date(d);
  }
  return null;
}

async function suspend() {
  if (process.platform === 'darwin') return require('./mac/power').suspend(nextWake());   // pmset instead of rtcwake + systemd
  const at = nextWake(); if (!at) return { ok: false, error: 'could not work out the next wake time' };
  const epoch = Math.floor(at.getTime() / 1000);
  const r = await run('sudo', ['-n', 'rtcwake', '-m', 'no', '-t', String(epoch)], { timeout: 8000 });
  if (!r.ok) return { ok: false, error: 'rtcwake failed: ' + (r.stderr || 'no sudo?').trim().split('\n').pop() };
  let set = ''; try { set = fs.readFileSync(ALARM, 'utf8').trim(); } catch {}
  // rtcwake writes the alarm in the RTC's own clock (rtc now + seconds to go). After a resume the RTC can sit a second
  // or so behind the system clock, so the stored value is e.g. epoch-1 — still the same 07:00. Allow small drift only.
  if (!set || Math.abs(+set - epoch) > MAX_DRIFT) return { ok: false, error: `the RTC alarm did not stick (wanted ${epoch}, got ${set || 'none'}) — NOT suspending` };   // never suspend without a verified alarm
  // a transient systemd unit, so it survives this service and the HTTP answer goes out first
  const s = await run('sudo', ['-n', 'systemd-run', '--on-active=4', '--unit=beast-sleep-' + epoch, 'systemctl', 'suspend'], { timeout: 8000 });
  if (!s.ok) { await run('sudo', ['-n', 'rtcwake', '-m', 'disable'], { timeout: 5000 }); return { ok: false, error: 'suspend failed: ' + (s.stderr || '').trim().split('\n').pop() }; }
  return { ok: true, wakeAt: at.getTime(), epoch };
}

module.exports = { nextWake, suspend };
