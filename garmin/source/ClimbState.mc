import Toybox.Lang;

// Which detected climb (index into model.climbs) the rider is inside, with
// hysteresis so GPS noise at the edges doesn't flap the zoom view: enter
// anywhere inside [startM, endM), leave only 100 m past the top or 200 m
// back before the foot. Entering requires a real geometric GPS match —
// dead reckoning may keep an already-open zoom alive but never opens one.
class ClimbState {
    hidden var _model;

    var current = -1;

    function initialize(model) {
        _model = model;
    }

    function update(d, geometric) {
        if (d == null) {
            return;
        }
        var climbs = _model.climbs;
        if (current >= 0) {
            var c = climbs[current];
            if (d >= c[1] + 100 || d < c[0] - 200) {
                current = -1;
            }
        }
        if (current < 0 && geometric) {
            for (var i = 0; i < climbs.size(); i++) {
                var c = climbs[i];
                if (d >= c[0] && d < c[1]) {
                    current = i;
                    break;
                }
            }
        }
    }

    // First climb starting after d, or -1.
    function next(d) {
        var climbs = _model.climbs;
        for (var i = 0; i < climbs.size(); i++) {
            if (climbs[i][0] > d) {
                return i;
            }
        }
        return -1;
    }
}
