import Toybox.Lang;
import Toybox.Math;

// Along-track position from GPS + the activity odometer, fused with a
// complementary filter. Works in the payload's own units: a flat plane of
// (lat, lon*cos(midLat)) in 1e-5-degree ticks (1 tick ~ 1.11 m).
//
// Raw geometric matching cannot be displayed directly: on hairpin roads
// (Alpe d'Huez: 21 of them) adjacent legs run 15-30 m apart while the
// nearest *vertex* on the rider's own leg can be step/2 (~55 m) away, so
// nearest-vertex matching flips legs and the along-track output hops
// hundreds of meters — verified against synthetic noisy rides over the
// real stage-19 track by ../preview/locator-sim.cjs, the JS twin of this
// file (keep in sync; run it after changes here). Design that passed:
//
// 1. The *output* advances by the odometer (elapsedDistance delta) —
//    smooth and monotone while riding forward.
// 2. GPS matches (point-to-SEGMENT projection in a tight window around
//    the expected position — segments, not vertices, so parallel legs
//    disambiguate) only pull the output by K x gap, clamped to CORR_MAX
//    per tick. Wrong-leg flips become sub-noise nudges that cancel.
// 3. Persistent disagreement beyond SNAP_M snaps after SNAP_TICKS
//    (rider rejoined the route somewhere else); backtracking is simply
//    tracked by the clamped correction (up to CORR_MAX m/s backwards).
// 4. No fix, or no acceptable match: coast on the odometer alone
//    (deadReckoned = true — ClimbState never *enters* a climb on it).
//    3 straight misses = OFF_ROUTE, cheap strided rescans every 5th fix,
//    2 hits to reacquire (output snaps to the new match).
class Locator {
    const ACCEPT_SQ = 8100.0; // ~(100 m / 1.11 m)^2
    const TIGHT = 3; // +-samples around the expected position
    const WINDOW = 40; // rescue scan half-width
    const K = 0.25; // fraction of the GPS-vs-odometer gap applied per tick
    const CORR_MAX = 12.0; // max correction, m/tick
    const SNAP_M = 250.0; // persistent disagreement beyond this snaps
    const SNAP_TICKS = 5;

    hidden var _model;
    hidden var _cosLat;

    hidden var _outD = null; // the filtered along-track output
    hidden var _lastElapsed = null;
    hidden var _misses = 0;
    hidden var _hits = 0;
    hidden var _offRoute = false;
    hidden var _sinceRescan = 0;
    hidden var _snapTicks = 0;

    var deadReckoned = false;

    function initialize(model) {
        _model = model;
        var midLat = model.lat[model.count() / 2] / 100000.0;
        _cosLat = Math.cos(midLat * Math.PI / 180.0);
    }

    function isOffRoute() {
        return _offRoute;
    }

    // Returns along-track meters (Float) or null when unknown.
    function locate(info) {
        deadReckoned = false;
        var dElapsed = 0.0;
        if (info.elapsedDistance != null) {
            if (_lastElapsed != null) {
                dElapsed = info.elapsedDistance - _lastElapsed;
                if (dElapsed < 0) {
                    dElapsed = 0.0;
                }
            }
            _lastElapsed = info.elapsedDistance;
        }
        var expected = null;
        if (_outD != null && !_offRoute) {
            expected = _outD + dElapsed;
            if (expected > _model.distM) {
                expected = _model.distM.toFloat();
            }
        }

        var loc = info.currentLocation;
        if (loc == null) {
            return _coast(expected);
        }
        var deg = loc.toDegrees();
        var pLat = deg[0] * 100000.0;
        var pLon = deg[1] * 100000.0;

        // While lost with no sight of the track, only rescan every 5th fix.
        if (_offRoute && _hits == 0) {
            _sinceRescan += 1;
            if (_sinceRescan < 5) {
                return null;
            }
            _sinceRescan = 0;
        }

        var r; // [alongTrackD or null, distSq]
        if (expected != null) {
            var ci = _model.idxOfDist(expected);
            r = _scanSegments(pLat, pLon, ci - TIGHT, ci + TIGHT);
            if (r[1] > ACCEPT_SQ) {
                var v = _scan(pLat, pLon, ci - WINDOW, ci + WINDOW, 1);
                if (v[0] >= 0) {
                    r = _scanSegments(pLat, pLon, v[0] - 2, v[0] + 2);
                }
            }
        } else {
            var v2 = _scan(pLat, pLon, 0, _model.count() - 1, 4);
            r = [null, 9.9e15];
            if (v2[0] >= 0) {
                r = _scanSegments(pLat, pLon, v2[0] - 4, v2[0] + 4);
            }
        }

        if (r[0] == null || r[1] > ACCEPT_SQ) {
            _hits = 0;
            _misses += 1;
            if (_misses >= 3) {
                _offRoute = true;
                _outD = null;
            }
            return _coast(expected);
        }
        var m = r[0];
        _misses = 0;
        _hits += 1;
        if (_offRoute) {
            if (_hits < 2) {
                return null; // want two consecutive hits to reacquire
            }
            _offRoute = false;
            _outD = m; // reacquired: snap
            _snapTicks = 0;
            return _outD;
        }
        if (expected == null) {
            _outD = m;
            _snapTicks = 0;
            return _outD;
        }
        var diff = m - expected;
        if (diff > SNAP_M || diff < -SNAP_M) {
            _snapTicks += 1;
            if (_snapTicks >= SNAP_TICKS) {
                _outD = m; // rider genuinely elsewhere on the route
                _snapTicks = 0;
                return _outD;
            }
            return _coast(expected);
        }
        _snapTicks = 0;
        var corr = K * diff;
        if (corr > CORR_MAX) {
            corr = CORR_MAX;
        }
        if (corr < -CORR_MAX) {
            corr = -CORR_MAX;
        }
        _outD = expected + corr;
        return _outD;
    }

    // Odometer-only progression when GPS is missing or untrusted.
    hidden function _coast(expected) {
        if (expected == null) {
            return null;
        }
        deadReckoned = true;
        _outD = expected;
        return expected;
    }

    // Nearest point-to-segment projection over segments [iLo, iHi) ->
    // [alongTrackD or null, distSq]. Segments, not vertices: the rider's
    // own leg is always ~noise-distance away, an adjacent hairpin leg
    // never is.
    hidden function _scanSegments(pLat, pLon, iLo, iHi) {
        if (iLo < 0) {
            iLo = 0;
        }
        var n = _model.count();
        if (iHi > n - 1) {
            iHi = n - 1;
        }
        var px = pLon * _cosLat;
        var py = pLat;
        var dBest = null;
        var sqBest = 9.9e15;
        var lats = _model.lat;
        var lons = _model.lon;
        for (var a = iLo; a < iHi; a++) {
            var b = a + 1;
            var ax = lons[a] * _cosLat;
            var ay = lats[a].toFloat();
            var vx = lons[b] * _cosLat - ax;
            var vy = lats[b] - ay;
            var vv = vx * vx + vy * vy;
            var t = 0.0;
            if (vv > 0) {
                t = ((px - ax) * vx + (py - ay) * vy) / vv;
                if (t < 0) {
                    t = 0.0;
                }
                if (t > 1) {
                    t = 1.0;
                }
            }
            var dx = px - (ax + vx * t);
            var dy = py - (ay + vy * t);
            var sq = dx * dx + dy * dy;
            if (sq < sqBest) {
                sqBest = sq;
                var d0 = _model.distOfIdx(a).toFloat();
                dBest = d0 + (_model.distOfIdx(b) - d0) * t;
            }
        }
        return [dBest, sqBest];
    }

    // Nearest vertex in [lo, hi] by squared planar distance; [idx, distSq].
    // Coarse pre-pass for the rescue and full-rescan paths.
    hidden function _scan(pLat, pLon, lo, hi, stride) {
        if (lo < 0) {
            lo = 0;
        }
        var n = _model.count();
        if (hi > n - 1) {
            hi = n - 1;
        }
        var best = -1;
        var bestSq = 9.9e15;
        var lats = _model.lat;
        var lons = _model.lon;
        for (var i = lo; i <= hi; i += stride) {
            var dLat = pLat - lats[i];
            var dLon = (pLon - lons[i]) * _cosLat;
            var sq = dLat * dLat + dLon * dLon;
            if (sq < bestSq) {
                bestSq = sq;
                best = i;
            }
        }
        return [best, bestSq];
    }
}
