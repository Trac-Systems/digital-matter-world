# V2 discovery reference

A pattern is a regular expression over a verified Bitcoin header field. The
FIRST accepted attribution is subject to the accepted commitment ordering;
copying the baseline wins nothing once its canonical definitions are accepted.
Invent definitions, check current names/keys and retain real named evidence.
Mainnet uses dmw-v2; the legacy whole-history vector equivalence and constant-count
ban are not v2 acceptance rules. Read current accepted settings before searching.

### Regular expressions and counting

A pattern IS a regular expression: JavaScript `RegExp` syntax, matched with the
**global flag** against the field's decimal or lowercase unpadded hexadecimal
string. Submit the regex source as `pat`, without `/…/g` delimiters or flags.
Height (`fld:4`) and nonce (`fld:10`) require `dt:"n"`; compact difficulty bits
(`fld:11`) accepts `dt:"n"` or `dt:"h"`. Hex has no `0x` prefix or leading padding.

The bounded subset allows literals `0-9` and lowercase `a-f`, non-negated
classes such as `[137]` or `[a-f]`, ascending ranges within digits or within
`a-f` (never `[9-a]`), `^` at a branch's start, `$` at its end, `?`, exact `{m}`
or bounded `{m,n}` repetition with `0 <= m <= n <= 10`, and up to four `|`
alternatives. Default limits are 64 source characters, six literal digit
characters across the entire expression, twelve atoms and four quantifiers
per branch. A class is one atom; digit members and range endpoints count toward
the six-digit limit, but repetition bounds do not: `[0-9]` uses two literal
digits and `7{3}` uses one. No groups, escapes (including `\d`), negated classes,
wildcards, lookarounds, backreferences, embedded flags, `*`, `+` or `{m,}`.
A pattern matching the empty string is rejected. Letters `a-f` are syntactically
valid in decimal patterns but cannot match decimal field strings.

By default, **units = the number of non-overlapping global matches**, not matched characters
or overlapping windows. `7{3}` on `7777` gives one unit; `f{2}` on `ffff` gives
two. Alternatives use JavaScript's left-to-right choice. No match gives zero
units. Rarity counts blocks with at least one match; total counts all units.

### Field value units

V2 definitions can select `amountMode:"field-value"` after the coordinated
activation height. The default remains regex match count. Value mode uses the
same regex and field/dt grammar to select blocks, then awards the field's entire
numeric value once; zero-valued blocks are omitted. Witness `count` and all unit
amounts stay decimal strings. The mode belongs to the definition's identity;
rarity still counts matching blocks. Local search can preview it before activation.
TAP provisioning uses a pattern-free `name.FIELD.element`, with DMW's privilege
authority enforcing block eligibility.

`Pattern amount modes require v2 rules` means a legacy search/proposal path was
given an amount mode; use the activated v2 context. `pattern_amount_inactive`
means a proposal cannot yet be committed on the current chain.
`pattern_amount_mode` rejects a value other than `count` or `field-value`.

V2 requires accepted minMatchingBlocks distinct matching headers. Constant counts
are allowed. Public knownMatchCount and knownOccurrenceTotal are revision-bound
lower bounds; local search counts cover only the stated verified snapshot.

Worked examples on real Bitcoin headers (height identifies the header):

| Field / format | Height | Actual field string | `pat` | Non-overlapping matches | Units |
|---|---:|---|---|---|---:|
| 4 / n | 22 | `22` | `2{2}` | `22` | 1 |
| 4 / n | 12 | `12` | `^[1-3]` | `1` | 1 |
| 4 / n | 21 | `21` | `12\|21` | `21` | 1 |
| 4 / n | 63 | `63` | `[7-9]$` | none | 0 |
| 10 / n | 0 | `2083236893` | `[2-3]` | `2`, `3`, `2`, `3`, `3` | 5 |
| 10 / n | 0 | `2083236893` | `^20` | `20` | 1 |
| 10 / n | 0 | `2083236893` | `3\|68` | `3`, `3`, `68`, `3` | 4 |
| 10 / n | 1 | `2573394689` | `3{2}` | `33` | 1 |
| 11 / n | 0 | `486604799` | `99$` | `99` | 1 |
| 11 / n | 0 | `486604799` | `6{2}` | `66` | 1 |
| 11 / h | 0 | `1d00ffff` | `f{2}` | `ff`, `ff` | 2 |
| 11 / h | 0 | `1d00ffff` | `^1[d-f]` | `1d` | 1 |

## Search example under v2 settings

This deterministic fixture uses the first 64 real mainnet headers (tip 63), an
empty **test** catalog and SETTINGS_PROFILE with puzzleBits:0 and
occurrencePageSize:3, network fixture, effectiveBatch:"43",
effectiveBitcoinWindow:"0". It is not the live catalog or a submission template.
The constant bits-field candidate is accepted; the duplicate definition and the
occupied name are rejected. Results preserve decimal witness fields and expose
local page cursors, not old discovery record/frozen rarity predictions.

Worked `search_patterns` call:

```js
search_patterns({
  "maxCandidates": 4,
  "candidates": [
    {
      "name": "dmwgemora",
      "pat": "[12]",
      "fld": 4,
      "dt": "n"
    },
    {
      "name": "dmwquartz",
      "pat": "^1",
      "fld": 11,
      "dt": "h"
    },
    {
      "name": "dmwothername",
      "pat": "[12]",
      "fld": 4,
      "dt": "n"
    },
    {
      "name": "dmwgemora",
      "pat": "[34]",
      "fld": 4,
      "dt": "n"
    }
  ]
});
```

Exact result for the v2 fixture:

```json
{
  "accepted": [
    {
      "proposal": {
        "name": "dmwgemora",
        "pat": "[12]",
        "fld": 4,
        "dt": "n"
      },
      "searchSnapshot": {
        "height": 63,
        "hash": "00000000ebff91c88984bff39511f544a1c4ef6ec4f33e2ea531e47c2685628e"
      },
      "localResultId": "2d62fac7d45564a955b91a75cf132e0e2fecd49836a69c4045b0024328a2c711",
      "matches": [
        {
          "height": "1",
          "hash": "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048",
          "count": "1"
        },
        {
          "height": "2",
          "hash": "000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd",
          "count": "1"
        },
        {
          "height": "10",
          "hash": "000000002c05cc2e78923c34df87fd108b22221ac6076c18f3ade378a4d915e9",
          "count": "1"
        }
      ],
      "searchedRange": {
        "from": 0,
        "to": 63
      },
      "completeLocalSearch": true,
      "nextCursor": "eyJuZXh0IjoxMSwicmVzdWx0IjoiMmQ2MmZhYzdkNDU1NjRhOTU1YjkxYTc1Y2YxMzJlMGUyZmVjZDQ5ODM2YTY5YzQwNDViMDAyNDMyOGEyYzcxMSIsInNuYXBzaG90Ijp7Imhhc2giOiIwMDAwMDAwMGViZmY5MWM4ODk4NGJmZjM5NTExZjU0NGExYzRlZjZlYzRmMzNlMmVhNTMxZTQ3YzI2ODU2MjhlIiwiaGVpZ2h0Ijo2M319",
      "key": "3d58c57a01d3ffc042df612b4bcefbfd91af6c44a6073f786f428e9f7d57bbb2",
      "localMatchCount": "30",
      "localOccurrenceTotal": "34"
    },
    {
      "proposal": {
        "name": "dmwquartz",
        "pat": "^1",
        "fld": 11,
        "dt": "h"
      },
      "searchSnapshot": {
        "height": 63,
        "hash": "00000000ebff91c88984bff39511f544a1c4ef6ec4f33e2ea531e47c2685628e"
      },
      "localResultId": "0c670f368d218d5af5019c27a39321c4d2b60b62081c2f261b1c1b60f06ca30b",
      "matches": [
        {
          "height": "0",
          "hash": "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
          "count": "1"
        },
        {
          "height": "1",
          "hash": "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048",
          "count": "1"
        },
        {
          "height": "2",
          "hash": "000000006a625f06636b8bb6ac7b960a8d03705d1ace08b1a19da3fdcc99ddbd",
          "count": "1"
        }
      ],
      "searchedRange": {
        "from": 0,
        "to": 63
      },
      "completeLocalSearch": true,
      "nextCursor": "eyJuZXh0IjozLCJyZXN1bHQiOiIwYzY3MGYzNjhkMjE4ZDVhZjUwMTljMjdhMzkzMjFjNGQyYjYwYjYyMDgxYzJmMjYxYjFjMWI2MGYwNmNhMzBiIiwic25hcHNob3QiOnsiaGFzaCI6IjAwMDAwMDAwZWJmZjkxYzg4OTg0YmZmMzk1MTFmNTQ0YTFjNGVmNmVjNGYzM2UyZWE1MzFlNDdjMjY4NTYyOGUiLCJoZWlnaHQiOjYzfX0",
      "key": "59a0ddc03d957a84c9afcc0b52b85cf28d5f2a016b658f7c592bf311465fb2b2",
      "localMatchCount": "64",
      "localOccurrenceTotal": "64"
    }
  ],
  "rejected": [
    {
      "name": "dmwothername",
      "reason": "pattern_duplicate"
    },
    {
      "name": "dmwgemora",
      "reason": "pattern_exists"
    }
  ]
}
```

## Validator and local-search errors

The shared parser retains legacy error codes for old fixtures. Rows marked
legacy-only are not new v2 constraints. Empty/nullable expressions remain invalid
on both versions. Grammar settings may tighten the hard bounds described above.

| Error | Meaning | Remedy |
| --- | --- | --- |
| `pattern_atom` | Unsupported token or misplaced anchor. | Use allowed literals/classes; remove groups, escapes, wildcards or unbounded operators; put anchors at branch edges. |
| `pattern_class` | Empty, unclosed or invalid class. | Close a nonempty class using only digits or lowercase a–f, with valid ranges and no negation. |
| `pattern_range` | Incomplete, reversed or mixed digit/letter range. | Use ascending ranges within 0–9 or a–f, such as `[2-5]` or `[b-f]`. |
| `pattern_quantifier` | Malformed bounds, minimum above maximum, or maximum above 10. | Use `?`, `{m}` or `{m,n}` with integers 0–10 and no leading zeros; require m ≤ n. |
| `pattern_complexity` | A branch exceeds twelve atoms or four quantifiers. | Shorten that branch or use a class/range; obey configured tighter limits. |
| `pattern_literal_digits` | More than six written digit literals across all branches/classes/range endpoints. | Replace enumerations with ranges or bounded runs; quantifier bounds do not count. |
| `pattern_length` | Source is empty, not a string, or exceeds 64 characters. | Supply a nonempty regex source within the configured length, without slash delimiters. |
| `pattern_alternatives` | More than four alternative branches. | Reduce branches or combine choices into a class. |
| `pattern_empty_branch` | A branch is empty or contains only anchors. | Remove empty alternatives and give each branch an atom. |
| `pattern_nullable` | The expression matches the empty string. | Require at least one character in every branch; remove wholly optional branches. |
| `pattern_constant` | Legacy-only rejection; v2 allows constant counts. | On v2 use canonical-definition validation and accepted named witnesses; do not impose a constant-vector ban. |
| `Pattern amount modes require v2 rules` | An amount mode was passed to the legacy search path. | Use a verified v2 rules context; omit the mode for legacy count searches. |
| `pattern_too_rare` | Fewer than the accepted minMatchingBlocks named blocks match. | Broaden the expression and retain enough verified named witnesses. |
| `pattern_duplicate` | v2: the same canonical definition is already accepted (or earlier in this search). Legacy v1: the complete count vector equals an existing pattern, even across fields. | Invent a different definition; a rename cannot fix it. |
| `pattern_exists` | The name or assigned pattern number is already taken. | Choose another readable name for a distinct idea; refresh the catalog if numbering is stale. |
| `pattern_name` | Name violates `dmw` plus 2–29 lowercase letters/digits. | Use a short pronounceable name in the required wire format. |
| `field` | Field/format pair is invalid. | Use 4/n or 10/n; only 11 permits n or h. |
| `pattern_limits` | Supplied validator limits are invalid or try to exceed hard grammar caps. | Restore supported limits; do not loosen protocol rules. |
| `field_value` | A header field is not an unsigned 32-bit integer. | Reload verified headers; never edit a header to make a proposal pass. |
| `rarity` | Invalid rarity value or tier thresholds (requires four increasing nonnegative integers). | Restore valid local rule configuration and verified history. |
| `discoverer` | Internal discoverer key or assigned pattern number is invalid. | Use the kit's signer identity and a fresh catalog; do not invent internal identity or numbering fields. |
| `headers_length` | Header archive is empty or its byte length is not a multiple of 80. | Reload a complete raw header file and verify it before searching. |
| `history_height` | A history read is outside the available archive. | Reload a complete verified archive reaching the exact current tip. |
| `header` | Invalid raw header bytes or height while reading history. | Reload and verify the header archive. |
| `Configure a verified header history first` | No history was configured for the tool. | Configure and load a verified complete archive. |
| `Load and verify the complete header file first` | The history object has not passed verification. | Load through the kit's history verifier. |
| `Full header history must reach the exact current tip before pattern search or proposal` | Verified archive and current tip disagree. | Refresh history and retry with the same player; keep the journal. |
| `Invalid search budget` | SDK search budget is not a positive safe integer within its internal cap. | For MCP/CLI use `maxCandidates` 1–60 (default 10); keep caller and strategy candidates within one budget. |
| `Use a checksum-valid trac1… Trac address; raw hex keys are not accepted.` | SDK search owner is not a public Trac address. | Use the address returned by the kit; its error code is `trac_address_required`. |
