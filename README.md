# Fast CSV reader — make.fun `csv-reader-speed-01-run-20261121`

A faster drop-in for make.fun's own csv-reader 1.0.0: `solve.js` answers
every case exactly as csv-reader does, and `main.ts` is the house driver
that reads `/input/cases.json` and writes `/output/answers.json`.

## How it works

- **Bulk fast path.** Most records are clean single lines (no quote, no
  stray CR). Each is taken in bulk: one slice + `split(',')` per record.
- **Index-based slow path.** A record with a quote or a stray CR is read
  field by field with `indexOf` jumps and slices — never a per-character
  loop over the whole text — reproducing csv-reader's broken-row policy
  exactly: BOM dropped, CRLF / lone CR inside quotes read as LF,
  `stray_cr` for a CR outside quotes, `quote_junk` for text after a
  closing quote, `unterminated_quote` re-read as unquoted, `short_row`
  padded and `long_row` cut to the first record's width, errors in the
  order met with the 1-based line the record starts on.
- **Deterministic.** No clock, no randomness, no environment reads: the
  same input always produces the same output bytes.

## Practice result (verified with the kit's own `grade-local`)

- `passed: 1`, **6/6 cases identical** to csv-reader 1.0.0, ranked and
  prize-eligible.
- Parser-only CPU on the practice set (median, 11 rounds): **~99 ms**
  against csv-reader's **~589 ms** — about **6x faster**.
- Differential-tested against the reference on 59 hand-written edge cases
  and 480 generator-drawn cases: all identical.

## Run locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), writes
`/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).
