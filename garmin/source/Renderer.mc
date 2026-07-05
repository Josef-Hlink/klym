import Toybox.Graphics;
import Toybox.Lang;

// All drawing for the field, sized off the actual Dc so a 1-field page on
// the Edge 540 (246x322) is the design target but nothing is hardcoded to
// it. Two real views — whole-route profile and climb zoom — plus status
// screens while the fetcher isn't loaded.
class Renderer {
    const MARGIN = 6;

    hidden var _bg;
    hidden var _fg;
    hidden var _subtle;
    hidden var _muted; // ridden-portion bars in the zoom view

    function draw(dc, bg, fetcher, locator, climbState, d) {
        _bg = bg;
        var dark = bg == Graphics.COLOR_BLACK;
        _fg = dark ? Graphics.COLOR_WHITE : Graphics.COLOR_BLACK;
        _subtle = dark ? Graphics.COLOR_LT_GRAY : Graphics.COLOR_DK_GRAY;
        _muted = dark ? Graphics.COLOR_DK_GRAY : Graphics.COLOR_LT_GRAY;

        dc.setColor(_fg, _bg);
        dc.clear();

        if (fetcher.state != RouteFetcher.LOADED) {
            drawStatus(dc, fetcher);
            return;
        }

        var model = fetcher.model;
        var zoomIdx = climbState != null ? climbState.current : -1;
        if (zoomIdx >= 0 && d != null) {
            drawZoom(dc, model, zoomIdx, d, locator);
        } else {
            drawRoute(dc, model, d, locator, climbState);
        }
    }

    hidden function drawStatus(dc, fetcher) {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var s = fetcher.state;
        var msg;
        if (s == RouteFetcher.NO_ROUTE) {
            msg = "no route sent";
        } else if (s == RouteFetcher.NO_PHONE) {
            msg = "waiting for phone";
        } else if (s == RouteFetcher.FAILED) {
            msg = "error " + fetcher.errorCode;
        } else {
            msg = "loading...";
        }
        dc.setColor(_fg, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h / 2 - dc.getFontHeight(Graphics.FONT_MEDIUM), Graphics.FONT_MEDIUM,
            "klym", Graphics.TEXT_JUSTIFY_CENTER);
        dc.setColor(_subtle, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, h / 2 + 6, Graphics.FONT_SMALL, msg, Graphics.TEXT_JUSTIFY_CENTER);
    }

    hidden function drawRoute(dc, model, d, locator, climbState) {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var hT = dc.getFontHeight(Graphics.FONT_TINY);

        dc.setColor(_fg, Graphics.COLOR_TRANSPARENT);
        dc.drawText(MARGIN, 2, Graphics.FONT_TINY,
            fitText(dc, model.name, Graphics.FONT_TINY, w - 2 * MARGIN),
            Graphics.TEXT_JUSTIFY_LEFT);

        var progress = d != null
            ? fmtKm1(d) + " / " + fmtKm1(model.distM) + " km"
            : fmtKm1(model.distM) + " km";
        if (locator != null && locator.deadReckoned) {
            progress = "~" + progress;
        }
        dc.setColor(_subtle, Graphics.COLOR_TRANSPARENT);
        dc.drawText(MARGIN, 2 + hT, Graphics.FONT_TINY, progress, Graphics.TEXT_JUSTIFY_LEFT);
        if (locator != null && locator.isOffRoute()) {
            dc.setColor(0xdc2626, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w - MARGIN, 2 + hT, Graphics.FONT_TINY, "off route",
                Graphics.TEXT_JUSTIFY_RIGHT);
        }

        var yBars = 2 + 2 * hT + 10;
        var hBars = h - 64 - yBars;
        drawBars(dc, model, 0, model.count() - 1, MARGIN, yBars, w - 2 * MARGIN, hBars, -1);

        if (d != null) {
            drawMarker(dc, MARGIN, yBars, w - 2 * MARGIN, hBars,
                d.toFloat() / model.distM);
        }

        drawGradePill(dc, MARGIN, h - 56, currentGrade(model, d));

        if (climbState != null && d != null) {
            var ni = climbState.next(d);
            if (ni >= 0) {
                var c = model.climbs[ni];
                dc.setColor(_subtle, Graphics.COLOR_TRANSPARENT);
                dc.drawText(w - MARGIN, h - 52, Graphics.FONT_TINY,
                    Palette.catLabel(c[2]) + " in " + fmtKm1(c[0] - d) + " km",
                    Graphics.TEXT_JUSTIFY_RIGHT);
                dc.drawText(w - MARGIN, h - 52 + hT, Graphics.FONT_TINY,
                    fmtKm1(c[1] - c[0]) + " km at " + (c[3] / 10.0).format("%.1f") + "%",
                    Graphics.TEXT_JUSTIFY_RIGHT);
            }
        }
    }

    hidden function drawZoom(dc, model, idx, d, locator) {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var hT = dc.getFontHeight(Graphics.FONT_TINY);
        var hS = dc.getFontHeight(Graphics.FONT_SMALL);
        var c = model.climbs[idx];

        // Category badge + "climb i/n".
        var label = Palette.catLabel(c[2]);
        var bw = dc.getTextWidthInPixels(label, Graphics.FONT_SMALL) + 16;
        dc.setColor(Palette.catColor(c[2]), Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(MARGIN, 4, bw, hS + 4, 4);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(MARGIN + bw / 2, 6, Graphics.FONT_SMALL, label, Graphics.TEXT_JUSTIFY_CENTER);
        dc.setColor(_subtle, Graphics.COLOR_TRANSPARENT);
        dc.drawText(MARGIN + bw + 8, 6, Graphics.FONT_TINY,
            "climb " + (idx + 1) + "/" + model.climbs.size(), Graphics.TEXT_JUSTIFY_LEFT);
        if (locator != null && locator.isOffRoute()) {
            dc.setColor(0xdc2626, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w - MARGIN, 6, Graphics.FONT_TINY, "off route",
                Graphics.TEXT_JUSTIFY_RIGHT);
        }

        // Remaining distance and gain.
        var remM = c[1] - d;
        if (remM < 0) {
            remM = 0.0;
        }
        var remGain = model.e[model.idxOfDist(c[1])] / 10.0 - model.eleMAt(d);
        if (remGain < 0) {
            remGain = 0.0;
        }
        var y1 = 8 + hS;
        dc.setColor(_fg, Graphics.COLOR_TRANSPARENT);
        dc.drawText(MARGIN, y1, Graphics.FONT_SMALL, fmtKm1(remM) + " km left",
            Graphics.TEXT_JUSTIFY_LEFT);
        dc.drawText(w - MARGIN, y1, Graphics.FONT_SMALL,
            remGain.toNumber().toString() + " m up", Graphics.TEXT_JUSTIFY_RIGHT);

        var i0 = model.idxOfDist(c[0]);
        var i1 = model.idxOfDist(c[1]);
        var yBars = y1 + hS + 12;
        var hBars = h - 64 - yBars;
        drawBars(dc, model, i0, i1, MARGIN, yBars, w - 2 * MARGIN, hBars, model.idxOfDist(d));

        var span = (c[1] - c[0]).toFloat();
        var frac = span > 0 ? (d - c[0]) / span : 0.0;
        if (frac < 0) {
            frac = 0.0;
        }
        if (frac > 1) {
            frac = 1.0;
        }
        drawMarker(dc, MARGIN, yBars, w - 2 * MARGIN, hBars, frac);

        drawGradePill(dc, MARGIN, h - 56, currentGrade(model, d));
        dc.setColor(_subtle, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w - MARGIN, h - 52 + hT / 2, Graphics.FONT_TINY,
            "avg left " + model.gradePct(model.idxOfDist(d), i1).format("%.1f") + "%",
            Graphics.TEXT_JUSTIFY_RIGHT);
    }

    // Profile bars for sample range [i0, i1] in rect (x, y, w, h), scaled to
    // the range's own min/max elevation. Samples below riddenIdx draw muted.
    hidden function drawBars(dc, model, i0, i1, x, y, w, h, riddenIdx) {
        var span = i1 - i0;
        if (span < 1 || w < 4 || h < 4) {
            return;
        }
        var barPx = 3;
        var nBars = w / barPx;
        if (nBars > span) {
            nBars = span;
            barPx = w / nBars;
        }
        var lo = model.e[i0];
        var hi = lo;
        for (var i = i0 + 1; i <= i1; i++) {
            if (model.e[i] < lo) {
                lo = model.e[i];
            }
            if (model.e[i] > hi) {
                hi = model.e[i];
            }
        }
        var range = (hi - lo).toFloat();
        if (range < 10) {
            range = 10.0;
        }
        var perBar = span.toFloat() / nBars;
        for (var b = 0; b < nBars; b++) {
            var s0 = i0 + (perBar * b).toNumber();
            var s1 = i0 + (perBar * (b + 1)).toNumber();
            if (s1 <= s0) {
                s1 = s0 + 1;
            }
            if (s1 > i1) {
                s1 = i1;
            }
            // Bucket height follows its peak so summits stay visible.
            var peak = model.e[s0];
            for (var i = s0 + 1; i <= s1; i++) {
                if (model.e[i] > peak) {
                    peak = model.e[i];
                }
            }
            var bh = (h * (peak - lo) / range).toNumber();
            if (bh < 2) {
                bh = 2;
            }
            var color = riddenIdx >= 0 && s1 < riddenIdx
                ? _muted
                : Palette.colorFor(model.gradePct(s0, s1));
            dc.setColor(color, Graphics.COLOR_TRANSPARENT);
            dc.fillRectangle(x + b * barPx, y + h - bh, barPx - 1, bh);
        }
    }

    hidden function drawMarker(dc, x, y, w, h, frac) {
        var mx = x + (w * frac).toNumber();
        dc.setColor(_fg, Graphics.COLOR_TRANSPARENT);
        dc.fillRectangle(mx, y, 2, h);
        dc.fillPolygon([[mx - 4, y - 7], [mx + 6, y - 7], [mx + 1, y]]);
    }

    hidden function drawGradePill(dc, x, y, grade) {
        var hM = dc.getFontHeight(Graphics.FONT_MEDIUM);
        var text = gradeText(grade);
        var tw = dc.getTextWidthInPixels(text, Graphics.FONT_MEDIUM);
        dc.setColor(Palette.colorFor(grade), Graphics.COLOR_TRANSPARENT);
        dc.fillRoundedRectangle(x, y, tw + 20, hM + 8, 6);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x + (tw + 20) / 2, y + 4, Graphics.FONT_MEDIUM, text,
            Graphics.TEXT_JUSTIFY_CENTER);
    }

    // Grade around the rider, one sample each side (a couple hundred meters).
    hidden function currentGrade(model, d) {
        if (d == null) {
            return 0.0;
        }
        var i = model.idxOfDist(d);
        var i0 = i > 0 ? i - 1 : 0;
        var i1 = i < model.count() - 1 ? i + 1 : model.count() - 1;
        return model.gradePct(i0, i1);
    }

    hidden function gradeText(grade) {
        return (grade >= 0 ? "+" : "") + grade.format("%.1f") + "%";
    }

    hidden function fmtKm1(m) {
        return (m / 1000.0).format("%.1f");
    }

    hidden function fitText(dc, text, font, maxW) {
        if (dc.getTextWidthInPixels(text, font) <= maxW) {
            return text;
        }
        var t = text;
        while (t.length() > 1 && dc.getTextWidthInPixels(t + "...", font) > maxW) {
            t = t.substring(0, t.length() - 1);
        }
        return t + "...";
    }
}
