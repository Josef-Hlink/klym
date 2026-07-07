import Toybox.Lang;

// klym's gradient scale and category badge colors, ported from
// src/lib/elevation.ts (THEME_BANDS.klym) and src/lib/climbs.ts
// (categoryColor). Single place to retune if adjacent bands quantize
// together on the Edge's transflective screen.
module Palette {
    const DESCENT = 0x64748b;

    // Ascending half-integer cutoffs; first band whose cutoff exceeds the
    // grade wins, open-ended top band. Any downhill is gray.
    const CUTOFFS = [0.5, 2.5, 4.5, 6.5, 8.5, 11.5];
    const BAND_COLORS = [0xeab308, 0xf59e0b, 0xf97316, 0xea580c, 0xdc2626, 0xb91c1c, 0x7f1d1d];

    function colorFor(gradePct) {
        if (gradePct < 0.0) {
            return DESCENT;
        }
        for (var i = 0; i < CUTOFFS.size(); i++) {
            if (gradePct < CUTOFFS[i]) {
                return BAND_COLORS[i];
            }
        }
        return BAND_COLORS[BAND_COLORS.size() - 1];
    }

    // Payload cat codes: 0 = uncategorized, 1 = '4' … 4 = '1', 5 = 'HC'.
    const CAT_LABELS = ["-", "4", "3", "2", "1", "HC"];
    const CAT_COLORS = [0xa3a3a3, 0xeab308, 0xf59e0b, 0xea580c, 0xb91c1c, 0x171717];

    function catLabel(code) {
        if (code < 0 || code >= CAT_LABELS.size()) {
            return "-";
        }
        return CAT_LABELS[code];
    }

    function catColor(code) {
        if (code < 0 || code >= CAT_COLORS.size()) {
            return CAT_COLORS[0];
        }
        return CAT_COLORS[code];
    }
}
