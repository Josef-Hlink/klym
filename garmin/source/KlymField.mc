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

    function initialize() {
        DataField.initialize();
        _fetcher = new RouteFetcher();
        _renderer = new Renderer();
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
        _d = _locator.locate(info);
        _climbs.update(_d, !_locator.deadReckoned);
    }

    function onUpdate(dc) {
        _renderer.draw(dc, getBackgroundColor(), _fetcher, _locator, _climbs, _d);
    }
}
