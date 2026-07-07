import Toybox.Application;
import Toybox.Communications;
import Toybox.Lang;
import Toybox.PersistedContent;
import Toybox.System;
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
        NO_TOKEN,
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
        // Compile-time Config wins when non-empty (sim builds bake the dev
        // server + devtoken); store builds leave it empty and read the
        // Connect IQ app settings instead.
        var base = Config.BASE_URL;
        if (base.length() == 0) {
            base = _prop("baseUrl");
        }
        var token = Config.TOKEN;
        if (token.length() == 0) {
            token = _prop("token");
        }
        if (base.length() == 0 || token.length() == 0) {
            state = NO_TOKEN;
            _cooldown = 15; // settings can arrive from the phone any moment
            return;
        }
        state = REQUESTING;
        Communications.makeWebRequest(
            base + "/api/garmin/current",
            { "token" => token },
            {
                :method => Communications.HTTP_REQUEST_METHOD_GET,
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
            },
            self.method(:onResponse)
        );
    }

    // Retry right away (settings changed, e.g. the token just arrived).
    function poke() {
        if (state != LOADED && state != REQUESTING) {
            _cooldown = 0;
            _backoff = 5;
        }
    }

    hidden function _prop(key) {
        var v = Application.Properties.getValue(key);
        return v instanceof String ? v : "";
    }

    function onResponse(code as Number,
            data as Dictionary or String or PersistedContent.Iterator or Null) as Void {
        System.println("klym fetch: code=" + code);
        if (data instanceof Dictionary) {
            System.println("klym fetch: v=" + data["v"] + " step=" + data["step"]
                + " dist=" + data["dist"]
                + " e?" + (data["e"] instanceof Array)
                + " lat?" + (data["lat"] instanceof Array)
                + " lon?" + (data["lon"] instanceof Array)
                + " c?" + (data["c"] instanceof Array));
        } else if (data != null) {
            System.println("klym fetch: data is " + data);
        }
        if (code == 200) {
            var m = RouteModel.fromJson(data);
            if (m != null) {
                model = m;
                state = LOADED;
                var st = System.getSystemStats();
                System.println("klym mem: " + st.usedMemory + "/" + st.totalMemory);
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
