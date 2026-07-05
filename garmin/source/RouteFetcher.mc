import Toybox.Communications;
import Toybox.Lang;
import Toybox.WatchUi;

// Fetches the current route through the paired phone. Data fields have no
// Timer, so retry pacing rides on compute()'s 1 Hz ticks: errors back off
// 5 -> 10 -> 20 -> 60 s and keep trying forever (the phone may only
// connect mid-ride); an empty slot re-checks every 60 s. After a
// successful load the fetcher goes quiet for the rest of the activity.
class RouteFetcher {
    enum {
        IDLE,
        REQUESTING,
        LOADED,
        NO_ROUTE,
        NO_PHONE,
        FAILED
    }

    var state = IDLE;
    var errorCode = 0;
    var model = null;

    hidden var _cooldown = 0;
    hidden var _backoff = 5;

    // Called once per second from compute().
    function tick() {
        if (state == LOADED || state == REQUESTING) {
            return;
        }
        _cooldown -= 1;
        if (_cooldown <= 0) {
            request();
        }
    }

    function request() {
        state = REQUESTING;
        Communications.makeWebRequest(
            Config.BASE_URL + "/api/garmin/current",
            { "token" => Config.TOKEN },
            {
                :method => Communications.HTTP_REQUEST_METHOD_GET,
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
            },
            self.method(:onResponse)
        );
    }

    function onResponse(code, data) {
        if (code == 200) {
            var m = RouteModel.fromJson(data);
            if (m != null) {
                model = m;
                state = LOADED;
                WatchUi.requestUpdate();
                return;
            }
            errorCode = 0; // unrecognized payload
            _fail();
        } else if (code == 404) {
            state = NO_ROUTE;
            errorCode = code;
            _cooldown = 60; // a route may be sent while we sit at the start
        } else if (code == Communications.BLE_CONNECTION_UNAVAILABLE) {
            state = NO_PHONE;
            errorCode = code;
            _cooldown = 5;
        } else {
            errorCode = code;
            _fail();
        }
        WatchUi.requestUpdate();
    }

    hidden function _fail() {
        state = FAILED;
        _cooldown = _backoff;
        _backoff *= 2;
        if (_backoff > 60) {
            _backoff = 60;
        }
    }
}
