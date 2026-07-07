import Toybox.Lang;

// Adaptive constant-grade sections — the device-side sibling of
// computeAdaptiveBins in src/lib/elevation.ts: vertical Douglas-Peucker
// over the resampled elevation array. A span splits at the sample farthest
// (vertically, decimeters) from the chord between its endpoints until every
// chord fits the tolerance; each surviving span becomes one section
// [startDistM, endDistM, avgGradePct, startEleDm, endEleDm]. The renderer
// draws the chords themselves, so the silhouette is the simplified
// profile — same smoothing the web app's adaptive bins produce.
module Sections {
    const EPS_CLIMB_DM = 40; // 4 m tolerance inside a climb zoom
    const EPS_ROUTE_DM = 150; // 15 m for the whole-route silhouette

    function compute(model, i0, i1, epsilonDm) {
        if (i1 - i0 < 1) {
            return [];
        }
        var e = model.e;
        var isBreak = {};
        var stackLo = [i0];
        var stackHi = [i1];
        while (stackLo.size() > 0) {
            var last = stackLo.size() - 1;
            var lo = stackLo[last];
            var hi = stackHi[last];
            stackLo = stackLo.slice(0, last);
            stackHi = stackHi.slice(0, last);
            if (hi - lo < 2) {
                continue;
            }
            var run = (hi - lo).toFloat();
            var maxDev = 0.0;
            var maxJ = -1;
            for (var j = lo + 1; j < hi; j++) {
                var expect = e[lo] + (e[hi] - e[lo]) * (j - lo) / run;
                var dev = e[j] - expect;
                if (dev < 0) {
                    dev = -dev;
                }
                if (dev > maxDev) {
                    maxDev = dev;
                    maxJ = j;
                }
            }
            if (maxJ >= 0 && maxDev > epsilonDm) {
                isBreak[maxJ] = true;
                stackLo.add(lo);
                stackHi.add(maxJ);
                stackLo.add(maxJ);
                stackHi.add(hi);
            }
        }
        var out = [];
        var a = i0;
        for (var j = i0 + 1; j <= i1; j++) {
            if (j == i1 || isBreak[j] == true) {
                out.add([
                    model.distOfIdx(a).toFloat(),
                    model.distOfIdx(j).toFloat(),
                    model.gradePct(a, j),
                    e[a].toFloat(),
                    e[j].toFloat()
                ]);
                a = j;
            }
        }
        return out;
    }
}
