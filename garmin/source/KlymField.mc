import Toybox.Activity;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.WatchUi;

// The data field. compute() (1 Hz) drives the fetch retry ticks, the
// along-track locator, and the climb-zoom state machine; onUpdate() hands
// everything to the Renderer. Meant for a 1-field page layout.
class KlymField extends WatchUi.DataField {
    hidden var _fetcher;
    hidden var _renderer;
    hidden var _locator = null;
    hidden var _climbs = null;
    hidden var _d = null;
    hidden var _routeSections = null;
    hidden var _climbSections = null;
    hidden var _climbSectionsIdx = -1;
    hidden var _demoD = null;
    hidden var _demoStart = 0.0;

    function initialize() {
        DataField.initialize();
        _fetcher = new RouteFetcher();
        _renderer = new Renderer();
    }

    function onSettingsChanged() {
        _fetcher.poke();
    }

    function compute(info) {
        _fetcher.tick();
        var model = _fetcher.model;
        if (model == null) {
            return;
        }
        if (_locator == null) {
            _locator = new Locator(model);
            _climbs = new ClimbState(model);
        }
        if (_routeSections == null) {
            _routeSections = Sections.compute(model, 0, model.count() - 1,
                Sections.EPS_ROUTE_DM);
        }
        if (Config.DEMO && info.currentLocation == null) {
            // Sim-only self-riding mode (make sim-config DEMO=true): no fix
            // means no activity playback, so ride the route ourselves for
            // hands-off visual checks. Any real fix takes over immediately.
            _d = _demoTick(model);
            _climbs.update(_d, true);
        } else {
            _d = _locator.locate(info);
            _climbs.update(_d, !_locator.deadReckoned);
        }
        // Section boundaries stay fixed for the whole climb (only the
        // window slides), so compute them once per climb entry.
        if (_climbs.current != _climbSectionsIdx) {
            _climbSectionsIdx = _climbs.current;
            _climbSections = null;
            if (_climbSectionsIdx >= 0) {
                var c = model.climbs[_climbSectionsIdx];
                _climbSections = Sections.compute(model,
                    model.idxOfDist(c[0]), model.idxOfDist(c[1]),
                    Sections.EPS_CLIMB_DM);
            }
        }
    }

    function onUpdate(dc) {
        _renderer.draw(dc, getBackgroundColor(), _fetcher, _locator, _climbs, _d,
            _routeSections, _climbSections);
    }

    // Advances 30 m per compute tick, starting 900 m before the first
    // climb; wraps back there past the route end.
    hidden function _demoTick(model) {
        if (_demoD == null) {
            _demoStart = 0.0;
            if (model.climbs.size() > 0) {
                _demoStart = model.climbs[0][0].toFloat() - 900;
                if (_demoStart < 0) {
                    _demoStart = 0.0;
                }
            }
            _demoD = _demoStart;
            return _demoD;
        }
        _demoD += 30;
        if (_demoD > model.distM) {
            _demoD = _demoStart;
        }
        return _demoD;
    }
}
