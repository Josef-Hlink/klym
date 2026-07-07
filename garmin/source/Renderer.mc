import Toybox.Graphics;
import Toybox.Lang;

// All drawing for the field, sized off the actual Dc so a 1-field page on
// the Edge 540 (246x322) is the design target but nothing is hardcoded to
// it. Profiles are drawn ClimbPro-style: a filled silhouette of the
// simplified profile (the section chords from Sections.mc), colored by
// klym's grade bands with % labels where a block is wide enough. The
// climb view is a 2 km sliding window with the rider at 20% (400 m
// behind, 1.6 km ahead), with a slim position track showing which slice
// of the whole climb is on screen.
class Renderer {
    const MARGIN = 6;
    const LABEL_MIN_PX = 24;

    hidden var _bg;
    hidden var _fg;
    hidden var _subtle;
    hidden var _muted; // ridden part of the route silhouette

    function draw(dc, bg, fetcher, locator, climbState, d, routeSections, climbSections) {
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
        if (zoomIdx >= 0 && d != null && climbSections != null) {
            drawZoom(dc, model, zoomIdx, d, locator, climbSections);
        } else {
            drawRoute(dc, model, d, locator, climbState, routeSections);
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

    hidden function drawRoute(dc, model, d, locator, climbState, sections) {
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

        var yProf = 2 + 2 * hT + 10;
        var hProf = h - 64 - yProf;
        if (sections != null) {
            drawProfile(dc, model, 0.0, model.distM.toFloat(), MARGIN, yProf,
                w - 2 * MARGIN, hProf, sections, d != null ? d : -1.0);
        }

        if (d != null && sections != null && sections.size() > 0) {
            var mx = MARGIN + ((w - 2 * MARGIN) * (d.toFloat() / model.distM)).toNumber();
            drawRider(dc, mx, yProf, surfaceY(model, sections, d.toFloat(),
                0.0, model.distM.toFloat(), yProf, hProf));
        }

        drawGradePill(dc, MARGIN, h - 56, currentGrade(model, d));

        if (climbState != null && d != null) {
            var ni = climbState.next(d);
            if (ni >= 0) {
                var c = model.climbs[ni];
                var what = c[2] >= 5 ? "HC"
                    : c[2] >= 1 ? "cat " + Palette.catLabel(c[2]) : "climb";
                dc.setColor(_subtle, Graphics.COLOR_TRANSPARENT);
                dc.drawText(w - MARGIN, h - 52, Graphics.FONT_TINY,
                    what + " in " + fmtKm1(c[0] - d) + " km",
                    Graphics.TEXT_JUSTIFY_RIGHT);
                dc.drawText(w - MARGIN, h - 52 + hT, Graphics.FONT_TINY,
                    fmtKm1(c[1] - c[0]) + " km at " + (c[3] / 10.0).format("%.1f") + "%",
                    Graphics.TEXT_JUSTIFY_RIGHT);
            }
        }
    }

    hidden function drawZoom(dc, model, idx, d, locator, sections) {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var hT = dc.getFontHeight(Graphics.FONT_TINY);
        var hS = dc.getFontHeight(Graphics.FONT_SMALL);
        var hM = dc.getFontHeight(Graphics.FONT_MEDIUM);
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
            (idx + 1) + "/" + model.climbs.size(), Graphics.TEXT_JUSTIFY_LEFT);
        if (locator != null && locator.isOffRoute()) {
            dc.setColor(0xdc2626, Graphics.COLOR_TRANSPARENT);
            dc.drawText(w - MARGIN, 6, Graphics.FONT_TINY, "off route",
                Graphics.TEXT_JUSTIFY_RIGHT);
        } else {
            // Whole-climb summary, so the window never hides the big picture.
            dc.drawText(w - MARGIN, 6, Graphics.FONT_TINY,
                fmtKm1(c[1] - c[0]) + " km @ " + (c[3] / 10.0).format("%.1f") + "%",
                Graphics.TEXT_JUSTIFY_RIGHT);
        }

        // Remaining distance and gain, big — the glanceable stuff.
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
        dc.drawText(MARGIN, y1, Graphics.FONT_MEDIUM, fmtKm1(remM) + " km",
            Graphics.TEXT_JUSTIFY_LEFT);
        dc.drawText(w - MARGIN, y1, Graphics.FONT_MEDIUM,
            "+" + remGain.toNumber().toString() + " m", Graphics.TEXT_JUSTIFY_RIGHT);

        // Distance left in the current section, under the remaining km.
        var si = 0;
        while (si < sections.size() - 1 && d >= sections[si][1]) {
            si++;
        }
        var secRem = sections[si][1] - d;
        if (secRem < 0) {
            secRem = 0.0;
        }
        var y2 = y1 + hM;
        dc.setColor(_subtle, Graphics.COLOR_TRANSPARENT);
        dc.drawText(MARGIN, y2, Graphics.FONT_TINY, fmtShortDist(secRem),
            Graphics.TEXT_JUSTIFY_LEFT);

        // Sliding 2 km window with the rider at 20% — the road ahead is
        // what matters, the ridden gray tail is just context. Clamped to
        // the climb.
        var dStart = d.toFloat() - 400;
        var dEnd = d.toFloat() + 1600;
        if (dStart < c[0]) {
            dStart = c[0].toFloat();
        }
        if (dEnd > c[1]) {
            dEnd = c[1].toFloat();
        }
        var yProf = y2 + hT + 6;
        var hProf = h - 77 - yProf; // leave room for the position track
        var wProf = w - 2 * MARGIN;
        drawProfile(dc, model, dStart, dEnd, MARGIN, yProf, wProf, hProf,
            sections, d.toFloat());

        // Rider marker inside the window. d can sit past the window during
        // the exit hysteresis (up to 100 m beyond the top) — clamp so the
        // dot parks on the edge instead of overflowing the profile rect.
        var span = dEnd - dStart;
        if (span > 0 && sections.size() > 0) {
            var dm = d.toFloat();
            if (dm < dStart) {
                dm = dStart;
            }
            if (dm > dEnd) {
                dm = dEnd;
            }
            var mx = MARGIN + (wProf * (dm - dStart) / span).toNumber();
            drawRider(dc, mx, yProf,
                surfaceY(model, sections, dm, dStart, dEnd, yProf, hProf));
        }

        // Position track: the whole climb as klym's classic 500 m
        // colored-bar strip, the on-screen window bracketed in fg.
        var climbLen = (c[1] - c[0]).toFloat();
        var ty = yProf + hProf + 8;
        var th = 6;
        if (climbLen > 0) {
            for (var b0 = c[0].toFloat(); b0 < c[1]; b0 += 500) {
                var b1 = b0 + 500;
                if (b1 > c[1]) {
                    b1 = c[1].toFloat();
                }
                if (b1 - b0 < 50) {
                    break;
                }
                var g = (model.eleMAt(b1) - model.eleMAt(b0)) / (b1 - b0) * 100;
                var xs = (wProf * (b0 - c[0]) / climbLen).toNumber();
                var xe = (wProf * (b1 - c[0]) / climbLen).toNumber() - 1;
                if (xe <= xs) {
                    continue;
                }
                dc.setColor(Palette.colorFor(g), Graphics.COLOR_TRANSPARENT);
                dc.fillRectangle(MARGIN + xs, ty, xe - xs, th);
            }
            var wx0 = (wProf * (dStart - c[0]) / climbLen).toNumber();
            var wx1 = (wProf * (dEnd - c[0]) / climbLen).toNumber();
            if (wx1 - wx0 < 6) {
                wx1 = wx0 + 6;
            }
            dc.setColor(_fg, Graphics.COLOR_TRANSPARENT);
            dc.fillRectangle(MARGIN + wx0, ty - 3, wx1 - wx0, 2);
            dc.fillRectangle(MARGIN + wx0, ty + th + 1, wx1 - wx0, 2);
            dc.fillRectangle(MARGIN + wx0, ty - 3, 2, th + 6);
            dc.fillRectangle(MARGIN + wx1 - 2, ty - 3, 2, th + 6);
        }

        drawGradePill(dc, MARGIN, h - 56, currentGrade(model, d));
        dc.setColor(_subtle, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w - MARGIN, h - 52 + hT / 2, Graphics.FONT_TINY,
            "avg left " + model.gradePct(model.idxOfDist(d), model.idxOfDist(c[1])).format("%.1f") + "%",
            Graphics.TEXT_JUSTIFY_RIGHT);
    }

    // y of the silhouette surface at distance d (same scaling math as
    // drawProfile, so the rider dot sits exactly on the drawn edge).
    hidden function surfaceY(model, sections, d, dStart, dEnd, yProf, hProf) {
        var lo = 9.9e15;
        var hi = -9.9e15;
        for (var s = 0; s < sections.size(); s++) {
            var vs = sections[s][0] > dStart ? sections[s][0] : dStart;
            var ve = sections[s][1] < dEnd ? sections[s][1] : dEnd;
            if (ve <= vs) {
                continue;
            }
            var eA = chordEleDm(sections[s], vs);
            var eB = chordEleDm(sections[s], ve);
            if (eA < lo) {
                lo = eA;
            }
            if (eB < lo) {
                lo = eB;
            }
            if (eA > hi) {
                hi = eA;
            }
            if (eB > hi) {
                hi = eB;
            }
        }
        var range = hi - lo;
        if (range < 20) {
            range = 20.0;
        }
        var si = 0;
        while (si < sections.size() - 1 && d >= sections[si][1]) {
            si++;
        }
        var ch = (hProf * (chordEleDm(sections[si], d) - lo) / range).toNumber();
        if (ch < 1) {
            ch = 1;
        }
        if (ch > hProf) {
            ch = hProf;
        }
        return yProf + hProf - ch;
    }

    // Thin stem from the top of the profile area down to a ring dot sitting
    // on the silhouette surface.
    hidden function drawRider(dc, mx, yProf, sy) {
        dc.setColor(_fg, Graphics.COLOR_TRANSPARENT);
        dc.fillRectangle(mx, yProf - 2, 2, sy - yProf - 2);
        dc.fillPolygon([[mx - 4, yProf - 8], [mx + 6, yProf - 8], [mx + 1, yProf - 1]]);
        dc.fillCircle(mx + 1, sy, 5);
        dc.setColor(_bg, Graphics.COLOR_TRANSPARENT);
        dc.fillCircle(mx + 1, sy, 2);
    }

    // Elevation (decimeters) on a section's chord at distance d — the
    // simplified profile the silhouette is drawn from.
    hidden function chordEleDm(s, d) {
        var run = s[1] - s[0];
        if (run <= 0) {
            return s[3];
        }
        var t = (d - s[0]) / run;
        if (t < 0) {
            t = 0.0;
        }
        if (t > 1) {
            t = 1.0;
        }
        return s[3] + (s[4] - s[3]) * t;
    }

    // Filled silhouette of the *simplified* profile for [dStart, dEnd] in
    // rect (x, y, w, h): 1 px columns along the section chords, colored by
    // the section's grade band, scaled to the window's own chord min/max.
    // Columns before riddenUntilD draw muted. Wide-enough sections get a
    // % label.
    hidden function drawProfile(dc, model, dStart, dEnd, x, y, w, h, sections, riddenUntilD) {
        var span = dEnd - dStart;
        if (span <= 0 || w < 4 || h < 8 || sections.size() == 0) {
            return;
        }

        // Chords are monotone within a section, so the window's extremes
        // live at (clamped) section edges.
        var lo = 9.9e15;
        var hi = -9.9e15;
        for (var s = 0; s < sections.size(); s++) {
            var vs = sections[s][0] > dStart ? sections[s][0] : dStart;
            var ve = sections[s][1] < dEnd ? sections[s][1] : dEnd;
            if (ve <= vs) {
                continue;
            }
            var eA = chordEleDm(sections[s], vs);
            var eB = chordEleDm(sections[s], ve);
            if (eA < lo) {
                lo = eA;
            }
            if (eB < lo) {
                lo = eB;
            }
            if (eA > hi) {
                hi = eA;
            }
            if (eB > hi) {
                hi = eB;
            }
        }
        var range = hi - lo;
        if (range < 20) {
            range = 20.0;
        }

        var si = 0;
        for (var px = 0; px < w; px++) {
            var dist = dStart + span * px / w;
            while (si < sections.size() - 1 && dist >= sections[si][1]) {
                si++;
            }
            var ch = (h * (chordEleDm(sections[si], dist) - lo) / range).toNumber();
            if (ch < 1) {
                ch = 1;
            }
            if (ch > h) {
                ch = h;
            }
            var color = riddenUntilD >= 0 && dist < riddenUntilD
                ? _muted
                : Palette.colorFor(sections[si][2]);
            dc.setColor(color, Graphics.COLOR_TRANSPARENT);
            dc.fillRectangle(x + px, y + h - ch, 1, ch);
        }

        // % labels on blocks wide enough to carry them.
        var fontH = dc.getFontHeight(Graphics.FONT_XTINY);
        for (var s = 0; s < sections.size(); s++) {
            var vs = sections[s][0] > dStart ? sections[s][0] : dStart;
            var ve = sections[s][1] < dEnd ? sections[s][1] : dEnd;
            if (ve <= vs) {
                continue;
            }
            var midD = (vs + ve) / 2;
            if (riddenUntilD >= 0 && midD < riddenUntilD) {
                continue;
            }
            var pxw = ((ve - vs) / span * w).toNumber();
            if (pxw < LABEL_MIN_PX) {
                continue;
            }
            var g = sections[s][2];
            var text = (g + (g >= 0 ? 0.5 : -0.5)).toNumber().toString() + "%";
            var mx = x + ((midD - dStart) / span * w).toNumber();
            var colH = (h * (chordEleDm(sections[s], midD) - lo) / range).toNumber();
            if (colH >= fontH + 6) {
                dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
                dc.drawText(mx, y + h - (colH + fontH) / 2, Graphics.FONT_XTINY, text,
                    Graphics.TEXT_JUSTIFY_CENTER);
            } else {
                dc.setColor(_subtle, Graphics.COLOR_TRANSPARENT);
                dc.drawText(mx, y + h - colH - fontH - 1, Graphics.FONT_XTINY, text,
                    Graphics.TEXT_JUSTIFY_CENTER);
            }
        }
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

    // "340 m" below 1 km (rounded to 10 m), "1.4 km" above.
    hidden function fmtShortDist(m) {
        if (m < 995) {
            return ((m / 10.0 + 0.5).toNumber() * 10).toString() + " m";
        }
        return fmtKm1(m) + " km";
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
