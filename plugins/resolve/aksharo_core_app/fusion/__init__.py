"""Fusion Text+ macro authoring (C08b).

`macro.py` generates and parses `AksharoCaption.setting`, a deterministic
Text+-based Fusion macro with published inputs for per-word highlight timing.
`style_map.py` classifies each of the 30 `@montaj/caption-styles` documents
against what that macro can express, using the explicit rule table in
`classification_rules.json` — the same table C06b mirrors for its Premiere
MOGRT style→param mapping.
"""

from __future__ import annotations
