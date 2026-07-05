import Toybox.Lang;
import Toybox.Math;

// Along-track position from GPS. Works in the payload's own units: a flat
// plane of (lat, lon*cos(midLat)) in 1e-5-degree ticks (1 tick ~ 1.11 m).
// Normal operation is a windowed nearest-vertex scan around the last
// match, refined by projecting onto the two adjacent segments; repeated
// misses trigger a cheap strided full rescan, then OFF_ROUTE. With no fix
// (or while lost briefly) it dead-reckons on elapsedDistance for display
// continuity only — ClimbState never trusts a dead-reckoned position.
class Locator {
    const ACCEPT_SQ = 8100.0; // ~(100 m / 1.11 m)^2
    const WINDOW = 40;

    hidden var _model;
    hidden var _cosLat;

    hidden var _lastIdx = -1;
    hidden var _misses = 0;
    hidden var _hits = 0;
    hidden var _offRoute = false;
    hidden var _sinceRescan = 0;
    hidden var _lastMatchD = null;
    hidden var _elapsedAtMatch = null;

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
        var loc = info.currentLocation;
        if (loc == null) {
            return _deadReckon(info);
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

        var r;
        if (_lastIdx >= 0 && !_offRoute) {
            r = _scan(pLat, pLon, _lastIdx - WINDOW, _lastIdx + WINDOW, 1);
        } else {
            r = _scan(pLat, pLon, 0, _model.count() - 1, 4);
            if (r[0] >= 0) {
                r = _scan(pLat, pLon, r[0] - 4, r[0] + 4, 1);
            }
        }

        if (r[0] < 0 || r[1] > ACCEPT_SQ) {
            return _miss(info);
        }

        _misses = 0;
        _hits += 1;
        if (_offRoute) {
            if (_hits < 2) {
                return null; // want two consecutive hits to reacquire
            }
            _offRoute = false;
        }

        _lastIdx = r[0];
        var d = _refine(pLat, pLon, r[0]);
        _lastMatchD = d;
        _elapsedAtMatch = info.elapsedDistance;
        return d;
    }

    // Nearest vertex in [lo, hi] by squared planar distance; [idx, distSq].
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

    // Project onto the segments flanking vertex i for ~10-20 m along-track
    // accuracy despite the coarse sample step.
    hidden function _refine(pLat, pLon, i) {
        var px = pLon * _cosLat;
        var py = pLat;
        var dBest = _model.distOfIdx(i).toFloat();
        var sqBest = 9.9e15;
        for (var s = -1; s <= 0; s++) {
            var a = i + s;
            var b = a + 1;
            if (a < 0 || b >= _model.count()) {
                continue;
            }
            var ax = _model.lon[a] * _cosLat;
            var ay = _model.lat[a].toFloat();
            var vx = _model.lon[b] * _cosLat - ax;
            var vy = _model.lat[b] - ay;
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
        return dBest;
    }

    hidden function _miss(info) {
        _hits = 0;
        _misses += 1;
        if (_misses >= 3) {
            _offRoute = true;
            _lastIdx = -1;
        }
        return _deadReckon(info);
    }

    hidden function _deadReckon(info) {
        if (_offRoute) {
            return null;
        }
        if (_lastMatchD == null || _elapsedAtMatch == null || info.elapsedDistance == null) {
            return null;
        }
        deadReckoned = true;
        var d = _lastMatchD + (info.elapsedDistance - _elapsedAtMatch);
        if (d > _model.distM) {
            d = _model.distM.toFloat();
        }
        return d;
    }
}
