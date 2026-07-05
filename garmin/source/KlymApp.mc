import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

class KlymApp extends Application.AppBase {
    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() {
        return [new KlymField()];
    }
}
