// Algorithmic verification of garmin/source/Locator.mc: a line-faithful JS
// port driven by synthetic 1 Hz GPS fixes walking the real stage-19 track
// (payload.js lat/lon, includes the 21 Alpe d'Huez hairpins), with Gaussian
// noise. Asserts the along-track output never steps backwards beyond noise.
// Run with `node locator-sim.cjs` after any Locator.mc change (port the
// change here first — this file is the twin, same keep-in-sync deal as
// preview.html).
// Load the preview harness payload (a browser global, not a module).
const _src = require("fs").readFileSync(__dirname + "/payload.js", "utf8");
const PAYLOAD = JSON.parse(_src.slice(_src.indexOf("{"), _src.lastIndexOf(";")));

class Model {
  constructor(p) {
    this.stepM = p.step; this.distM = p.dist;
    this.e = p.e; this.lat = p.lat; this.lon = p.lon;
  }
  count() { return this.lat.length; }
  distOfIdx(i) { const d = i * this.stepM; return d < this.distM ? d : this.distM; }
}

// ---- Locator.mc port (odometer + complementary filter redesign) ----
class Locator {
  constructor(model) {
    this.ACCEPT_SQ = 8100.0; // ~(100 m)^2 in 1e-5-deg ticks
    this.TIGHT = 3;          // +-3 samples around the expected position
    this.WINDOW = 40;        // rescue scan half-width
    this.K = 0.25;           // fraction of the GPS-vs-odometer gap applied per tick
    this.CORR_MAX = 12.0;    // max correction m/tick
    this.SNAP_M = 250.0;     // persistent disagreement beyond this snaps
    this.SNAP_TICKS = 5;
    this._model = model;
    const midLat = model.lat[Math.trunc(model.count() / 2)] / 100000.0;
    this._cosLat = Math.cos(midLat * Math.PI / 180.0);
    this._outD = null;       // filtered along-track output
    this._lastElapsed = null;
    this._misses = 0; this._hits = 0;
    this._offRoute = false; this._sinceRescan = 0; this._snapTicks = 0;
    this.deadReckoned = false;
  }
  isOffRoute() { return this._offRoute; }

  _idxOfDist(d) {
    let i = Math.trunc(d / this._model.stepM + 0.5);
    if (i < 0) i = 0;
    if (i >= this._model.count()) i = this._model.count() - 1;
    return i;
  }

  locate(info) {
    this.deadReckoned = false;
    let dElapsed = 0.0;
    if (info.elapsedDistance != null) {
      if (this._lastElapsed != null) {
        dElapsed = info.elapsedDistance - this._lastElapsed;
        if (dElapsed < 0) dElapsed = 0.0;
      }
      this._lastElapsed = info.elapsedDistance;
    }
    let expected = null;
    if (this._outD != null && !this._offRoute) {
      expected = this._outD + dElapsed;
      if (expected > this._model.distM) expected = this._model.distM;
    }

    const loc = info.currentLocation;
    if (loc == null) return this._coast(expected);
    const pLat = loc[0] * 100000.0, pLon = loc[1] * 100000.0;

    if (this._offRoute && this._hits === 0) {
      this._sinceRescan += 1;
      if (this._sinceRescan < 5) return null;
      this._sinceRescan = 0;
    }

    let m = null, sq = 9.9e15;
    if (expected != null) {
      const ci = this._idxOfDist(expected);
      [m, sq] = this._scanSegments(pLat, pLon, ci - this.TIGHT, ci + this.TIGHT);
      if (sq > this.ACCEPT_SQ) {
        const r = this._scan(pLat, pLon, ci - this.WINDOW, ci + this.WINDOW, 1);
        if (r[0] >= 0) [m, sq] = this._scanSegments(pLat, pLon, r[0] - 2, r[0] + 2);
      }
    } else {
      const r = this._scan(pLat, pLon, 0, this._model.count() - 1, 4);
      if (r[0] >= 0) [m, sq] = this._scanSegments(pLat, pLon, r[0] - 4, r[0] + 4);
    }

    if (m == null || sq > this.ACCEPT_SQ) {
      this._hits = 0;
      this._misses += 1;
      if (this._misses >= 3) { this._offRoute = true; this._outD = null; }
      return this._coast(expected);
    }
    this._misses = 0;
    this._hits += 1;
    if (this._offRoute) {
      if (this._hits < 2) return null;
      this._offRoute = false;
      this._outD = m; // reacquired: snap
      this._snapTicks = 0;
      return this._outD;
    }
    if (expected == null) {
      this._outD = m;
      this._snapTicks = 0;
      return this._outD;
    }
    const diff = m - expected;
    if (diff > this.SNAP_M || diff < -this.SNAP_M) {
      this._snapTicks += 1;
      if (this._snapTicks >= this.SNAP_TICKS) {
        this._outD = m; // rider genuinely elsewhere (backtracked, rejoined)
        this._snapTicks = 0;
        return this._outD;
      }
      return this._coast(expected);
    }
    this._snapTicks = 0;
    let corr = this.K * diff;
    if (corr > this.CORR_MAX) corr = this.CORR_MAX;
    if (corr < -this.CORR_MAX) corr = -this.CORR_MAX;
    this._outD = expected + corr;
    return this._outD;
  }

  // Odometer-only progression when GPS is missing or untrusted.
  _coast(expected) {
    if (expected == null) return null;
    this.deadReckoned = true;
    this._outD = expected;
    return expected;
  }

  // Nearest point-to-segment projection over segments [iLo, iHi) ->
  // [alongTrackD, distSq]. Vertex scans can't disambiguate hairpin legs
  // (own-leg vertex up to step/2 away vs the adjacent leg ~20 m across);
  // segment projection can.
  _scanSegments(pLat, pLon, iLo, iHi) {
    if (iLo < 0) iLo = 0;
    const n = this._model.count();
    if (iHi > n - 1) iHi = n - 1;
    const px = pLon * this._cosLat, py = pLat;
    let dBest = null, sqBest = 9.9e15;
    for (let a = iLo; a < iHi; a++) {
      const b = a + 1;
      const ax = this._model.lon[a] * this._cosLat, ay = this._model.lat[a];
      const vx = this._model.lon[b] * this._cosLat - ax, vy = this._model.lat[b] - ay;
      const vv = vx * vx + vy * vy;
      let t = 0.0;
      if (vv > 0) {
        t = ((px - ax) * vx + (py - ay) * vy) / vv;
        if (t < 0) t = 0.0;
        if (t > 1) t = 1.0;
      }
      const dx = px - (ax + vx * t), dy = py - (ay + vy * t);
      const sq = dx * dx + dy * dy;
      if (sq < sqBest) {
        sqBest = sq;
        const d0 = this._model.distOfIdx(a);
        dBest = d0 + (this._model.distOfIdx(b) - d0) * t;
      }
    }
    return [dBest, sqBest];
  }

  _scan(pLat, pLon, lo, hi, stride) {
    if (lo < 0) lo = 0;
    const n = this._model.count();
    if (hi > n - 1) hi = n - 1;
    let best = -1, bestSq = 9.9e15;
    const lats = this._model.lat, lons = this._model.lon;
    for (let i = lo; i <= hi; i += stride) {
      const dLat = pLat - lats[i];
      const dLon = (pLon - lons[i]) * this._cosLat;
      const sq = dLat * dLat + dLon * dLon;
      if (sq < bestSq) { bestSq = sq; best = i; }
    }
    return [best, bestSq];
  }
}

// ---- Synthetic ride ----
// Interpolate a true position at along-track distance d, add noise, feed
// the locator. Deterministic RNG so runs are reproducible.
let seed = 12345;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function gauss() { return (rand() + rand() + rand() + rand() - 2) * 1.7; } // ~N(0,1)

const model = new Model(PAYLOAD);
function trueLatLon(d) {
  const f = d / model.stepM;
  let i = Math.trunc(f);
  if (i >= model.count() - 1) i = model.count() - 2;
  const t = f - i;
  return [
    (model.lat[i] * (1 - t) + model.lat[i + 1] * t) / 100000.0,
    (model.lon[i] * (1 - t) + model.lon[i + 1] * t) / 100000.0
  ];
}

function ride(label, speed, noiseM, dropoutPct) {
  const loc = new Locator(model);
  const cosLat = Math.cos(model.lat[Math.trunc(model.count() / 2)] / 100000.0 * Math.PI / 180.0);
  let worstBack = 0, backCount = 0, nullCount = 0, offRouteTicks = 0;
  let maxErr = 0, errSum = 0, errN = 0;
  let prev = null;
  for (let t = 0; t * speed < model.distM - speed; t++) {
    const dTrue = t * speed;
    let info;
    if (rand() < dropoutPct) {
      info = { currentLocation: null, elapsedDistance: dTrue };
    } else {
      const [la, lo] = trueLatLon(dTrue);
      const nLat = gauss() * noiseM / 111320.0;
      const nLon = gauss() * noiseM / (111320.0 * cosLat);
      info = { currentLocation: [la + nLat, lo + nLon], elapsedDistance: dTrue };
    }
    const d = loc.locate(info);
    if (loc.isOffRoute()) offRouteTicks++;
    if (d == null) { nullCount++; continue; }
    const err = Math.abs(d - dTrue);
    if (!loc.deadReckoned) { maxErr = Math.max(maxErr, err); errSum += err; errN++; }
    if (prev != null && d < prev) {
      const back = prev - d;
      if (back > worstBack) worstBack = back;
      if (back > 30) backCount++; // noise-level jitter is fine; hops aren't
    }
    prev = d;
  }
  console.log(
    `${label}: worstBack=${worstBack.toFixed(1)}m hops(>30m)=${backCount} ` +
    `maxErr=${maxErr.toFixed(1)}m avgErr=${(errSum / errN).toFixed(1)}m ` +
    `null=${nullCount} offRouteTicks=${offRouteTicks}`
  );
  return { worstBack, backCount };
}

console.log("stage 19, " + (model.distM / 1000).toFixed(1) + " km, step " + model.stepM + " m, " + model.count() + " pts");
let fail = 0;
// climbing pace on AdH & fast flat pace; typical + bad GPS; some dropouts
for (const [label, speed, noise, drop] of [
  ["5 m/s  noise 8m  drop 0%", 5, 8, 0],
  ["5 m/s  noise 15m drop 5%", 5, 15, 0.05],
  ["10 m/s noise 8m  drop 0%", 10, 8, 0],
  ["15 m/s noise 12m drop 2%", 15, 12, 0.02],
]) {
  const r = ride(label, speed, noise, drop);
  if (r.backCount > 0) fail++;
}
console.log(fail === 0 ? "PASS: no backward hops in any scenario" : `FAIL: ${fail} scenario(s) with backward hops`);
