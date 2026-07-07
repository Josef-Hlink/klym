import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

class KlymApp extends Application.AppBase {
    hidden var _field;

    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        _field = new KlymField();
        return [_field];
    }

    // Settings edited in Garmin Connect land here mid-activity — retry the
    // fetch immediately instead of waiting out the cooldown.
    function onSettingsChanged() {
        if (_field != null) {
            _field.onSettingsChanged();
        }
        WatchUi.requestUpdate();
    }
}
