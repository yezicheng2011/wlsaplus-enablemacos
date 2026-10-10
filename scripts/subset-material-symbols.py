"""Regeneration helper only; normal npm builds use the checked-in font."""
import json
import sys
from fontTools import subset
from fontTools.ttLib import TTFont


def ligatures(font):
    letters = {glyph: chr(code) for code, glyph in font.getBestCmap().items() if code < 128}
    result = {}
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for table in lookup.SubTable:
            if lookup.LookupType == 7:
                table = table.ExtSubTable
            for first, values in getattr(table, 'ligatures', {}).items():
                for value in values:
                    text = ''.join(letters.get(glyph, '?') for glyph in [first, *value.Component])
                    result[text] = value.LigGlyph
    return result


icons = json.load(sys.stdin)
font = TTFont(sys.argv[1])
mapping = ligatures(font)
glyphs = set(font.getGlyphOrder())
# Resolve aliases such as location_on -> place before keeping the fill variants.
selected = {glyph for name in icons for glyph in (mapping[name], mapping[name] + '.fill') if glyph in glyphs}
subsetter = subset.Subsetter(options=subset.Options(layout_closure=False))
subsetter.populate(glyphs=selected, unicodes=[32, *range(48, 58), 95, *range(97, 123)])
subsetter.subset(font)
missing = set(icons) - ligatures(font).keys()
if missing:
    raise ValueError(f'Subset lost icon ligatures: {sorted(missing)}')
font.flavor = 'woff2'
font.save(sys.argv[2])
