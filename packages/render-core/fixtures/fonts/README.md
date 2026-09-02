# Test fixture fonts

These three fonts exist **only so the test suite has deterministic metrics**. They are
not the product's font catalogue: the shipped, subset fonts are supplied at runtime by
A18b through the `FontRegistry`, fetched from R2/CDN. Nothing outside tests, benchmarks
and the preview build script may import from here.

| File                                    | Family               | Covers                                   | Licence                                 |
| --------------------------------------- | -------------------- | ---------------------------------------- | --------------------------------------- |
| `NotoSans-Regular-subset.ttf`           | Noto Sans            | Basic Latin, Latin-1, common punctuation | [OFL 1.1](./OFL-NotoSans.txt)           |
| `NotoSansDevanagari-Regular-subset.ttf` | Noto Sans Devanagari | Devanagari + Devanagari Extended + ASCII | [OFL 1.1](./OFL-NotoSansDevanagari.txt) |
| `NotoSansTamil-Regular-subset.ttf`      | Noto Sans Tamil      | Tamil + ASCII                            | [OFL 1.1](./OFL-NotoSansTamil.txt)      |

## Provenance

Upstream: the [Noto fonts](https://github.com/notofonts) release repositories
(`latin-greek-cyrillic`, `devanagari`, `tamil`), hinted TTF builds, Noto Sans 2.015,
Noto Sans Devanagari 2.006, Noto Sans Tamil 2.004.

Each file is a **subset** produced with `fonttools` 4.64.0:

```
python -m fontTools.subset <upstream>.ttf \
  --output-file=<file> \
  --unicodes="<the block(s) in the table above>" \
  --layout-features="*" --notdef-outline --name-IDs="*" --drop-tables+=DSIG
```

`--layout-features="*"` keeps every GSUB/GPOS lookup, which is what makes the
Devanagari and Tamil shaping in the golden tests real rather than a fallback: matra
reordering, conjuncts and mark positioning all still happen.

## Licence and naming

All three are licensed under the SIL Open Font License 1.1 (copies alongside each
font). The Noto copyright lines declare **no Reserved Font Name**, so the subsets keep
their upstream family names — `Noto Sans`, `Noto Sans Devanagari`, `Noto Sans Tamil` —
and are attributed to "The Noto Project Authors" exactly as upstream. Do not rename the
families: the registry resolves them by name and the golden hashes are tied to them.
