import Toybox.Lang;

// The decoded /api/garmin/current payload. Arrays are kept by reference
// exactly as parsed (memory is tight); one shared index space:
// index i <-> distance min(i*step, dist) <-> e[i] (decimeters)
// <-> (lat[i], lon[i]) (degrees * 1e5).
class RouteModel {
    var name;
    var stepM;
    var distM;
    var e; // Array<Number>, decimeters
    var lat; // Array<Number>, deg * 1e5
    var lon;
    var climbs; // Array of [startM, endM, cat, avgGrade10, gainM, maxGrade10]

    // Returns null unless the payload looks like schema v1.
    static function fromJson(data) {
        if (!(data instanceof Dictionary)) {
            return null;
        }
        if (data["v"] != 1) {
            return null;
        }
        var e = data["e"];
        var lat = data["lat"];
        var lon = data["lon"];
        if (!(e instanceof Array) || e.size() < 2) {
            return null;
        }
        if (!(lat instanceof Array) || lat.size() != e.size()) {
            return null;
        }
        if (!(lon instanceof Array) || lon.size() != e.size()) {
            return null;
        }
        var m = new RouteModel();
        m.name = data["name"] instanceof String ? data["name"] : "route";
        m.stepM = data["step"];
        m.distM = data["dist"];
        m.e = e;
        m.lat = lat;
        m.lon = lon;
        m.climbs = data["c"] instanceof Array ? data["c"] : [];
        if (!(m.stepM instanceof Number) || m.stepM <= 0) {
            return null;
        }
        if (!(m.distM instanceof Number) || m.distM <= 0) {
            return null;
        }
        return m;
    }

    function count() {
        return e.size();
    }

    function distOfIdx(i) {
        var d = i * stepM;
        return d < distM ? d : distM;
    }

    // Nearest sample index for an along-track distance.
    function idxOfDist(d) {
        var i = (d.toFloat() / stepM + 0.5).toNumber();
        if (i < 0) {
            i = 0;
        }
        if (i >= e.size()) {
            i = e.size() - 1;
        }
        return i;
    }

    // Elevation in meters at an along-track distance, lerped between samples.
    function eleMAt(d) {
        var f = d.toFloat() / stepM;
        var i = f.toNumber();
        if (i < 0) {
            i = 0;
        }
        if (i >= e.size() - 1) {
            return e[e.size() - 1] / 10.0;
        }
        var t = f - i;
        return (e[i] * (1.0 - t) + e[i + 1] * t) / 10.0;
    }

    // Average grade (%) between two sample indices. Decimeters over meters
    // cancel to a factor 10 — same math as computeBins in the web app.
    function gradePct(i0, i1) {
        if (i1 <= i0) {
            return 0.0;
        }
        var dDistM = distOfIdx(i1) - distOfIdx(i0);
        if (dDistM <= 0) {
            return 0.0;
        }
        return (e[i1] - e[i0]) * 10.0 / dDistM;
    }
}
