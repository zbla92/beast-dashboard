// Low-battery push: once at 25 %, once more at 10 %, per discharge. Draining = unplugged, or on a charger too weak to
// keep up (the same rule as the tile). Armed again only once the charge is back above 30 %, so a weak charger that
// flips between Charging and Discharging around 20 % doesn't buzz on every flip. Starting already below both levels
// gives one push, not two.
const LEVELS = [25, 10], REARM = 30;

function createBatteryAlert(levels = LEVELS, rearm = REARM) {
  let next = 0;   // index of the next level that pushes; levels.length = nothing left this discharge
  return {
    // the lowest level this sample crossed (push now), or null
    check(b) {
      if (!b) return null;
      if (b.pct > rearm) { next = 0; return null; }
      if ((b.ac && b.status !== 'Discharging') || next >= levels.length || b.pct > levels[next]) return null;
      while (next < levels.length && b.pct <= levels[next]) next++;
      return levels[next - 1];
    },
  };
}

module.exports = { createBatteryAlert, LEVELS, REARM };
