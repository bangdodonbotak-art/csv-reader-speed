// Fast CSV reader matching csv-reader 1.0.0 exactly (make.fun csv-reader-speed-01).
//
// Written from the published behaviour spec (RULES.txt) and the reference's
// observable semantics, not from its code: a single left-to-right pass that
// answers {columns, rows, errors} for {text, header}.
//
// Speed idea: most records are clean single lines (no quote, no stray CR).
// Those are taken in bulk — one slice + split(',') per record. Anything
// with a quote or a stray CR goes through an index-based field scanner
// (indexOf jumps + slices, never a per-character loop over the whole text),
// which reproduces the reference's broken-row policy exactly.
//
// Broken-row policy (as specified):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line with no characters is no record.
// - Outside quotes, a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next non-doubled quote; ""
//   inside it is one quote; CRLF / lone CR inside it read as LF; what
//   follows its closing quote up to the next comma or line break is appended
//   as it stands (quote_junk when the field ends); a quote that never closes
//   is a literal character and the text after it is read again as unquoted
//   (unterminated_quote). A quote inside an unquoted field is literal.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows hold
//   the records after it, each padded (short_row, with fields: its count)
//   or cut (long_row, with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row} in the order met; line is the 1-based
//   line its record starts on (counting every LF, CRLF and lone CR inside
//   quotes), row its record's index in rows (null for the header).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Read by the helpers below while a record runs.
  let recordLine = 1;
  let recordRow = null;

  // readUnquoted's result, held here instead of a fresh object per field.
  let uValue = '';
  let uEnded = 0;
  let uAdded = 0;

  // A span of quoted content [start, end): CRLF and lone CR each become one
  // LF, and `line` advances by the line breaks it holds.
  function convertSegment(start, end) {
    const seg = text.slice(start, end);
    if (seg.indexOf('\r') === -1) {
      let c = 0;
      let i = seg.indexOf('\n');
      while (i !== -1) {
        c++;
        i = seg.indexOf('\n', i + 1);
      }
      line += c;
      return seg;
    }
    const conv = seg.replace(/\r\n?/g, '\n');
    let c = 0;
    let i = conv.indexOf('\n');
    while (i !== -1) {
      c++;
      i = conv.indexOf('\n', i + 1);
    }
    line += c;
    return conv;
  }

  // Reads unquoted characters onto `init` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). The result is left
  // in uValue/uEnded/uAdded (no fresh object per field).
  function readUnquoted(init) {
    uValue = init;
    uAdded = 0;
    while (true) {
      const cIdx = text.indexOf(',', pos);
      const nIdx = text.indexOf('\n', pos);
      let m;
      let kind;
      if (cIdx === -1 && nIdx === -1) {
        m = n;
        kind = END;
      } else if (cIdx === -1) {
        m = nIdx;
        kind = LINE_BREAK;
      } else if (nIdx === -1) {
        m = cIdx;
        kind = COMMA;
      } else if (cIdx < nIdx) {
        m = cIdx;
        kind = COMMA;
      } else {
        m = nIdx;
        kind = LINE_BREAK;
      }
      const seg = text.slice(pos, m);
      const r = seg.indexOf('\r');
      if (r === -1) {
        if (uValue.length === 0) uValue = seg;
        else uValue += seg;
        uAdded += seg.length;
        if (kind === COMMA) {
          pos = m + 1;
          uEnded = COMMA;
          return;
        }
        if (kind === LINE_BREAK) {
          pos = m + 1;
          line += 1;
          uEnded = LINE_BREAK;
          return;
        }
        pos = n;
        uEnded = END;
        return;
      }
      if (kind === LINE_BREAK && r === seg.length - 1) {
        // CRLF: the CR sits right before the LF.
        if (uValue.length === 0) uValue = seg.slice(0, r);
        else uValue += seg.slice(0, r);
        uAdded += r;
        pos = m + 1;
        line += 1;
        uEnded = LINE_BREAK;
        return;
      }
      // A stray CR inside the field: dropped, error recorded, read on.
      uValue += seg.slice(0, r);
      uAdded += r;
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      pos = pos + r + 1;
    }
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields;
    let quoted = false;

    // Fast path: a clean single-line record — no quote and no stray CR on
    // its first line. (A record with a quote or a stray CR always goes slow:
    // the first line is the whole record only when it holds neither.)
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    const raw = text.slice(pos, lineEnd);
    if (raw.indexOf('"') === -1) {
      const r = raw.indexOf('\r');
      if (r === -1 || (nl !== -1 && r === raw.length - 1)) {
        fields = (r === -1 ? raw : raw.slice(0, -1)).split(',');
        pos = nl === -1 ? n : nl + 1;
        line += 1;
      }
    }

    if (fields === undefined) {
      // Slow path: the record holds a quote or a stray CR. Read it field
      // by field, exactly as the reference does.
      fields = [];
      let ended = false;
      while (!ended) {
        quoted = text.charCodeAt(pos) === 34;
        let value;
        let done;
        if (quoted) {
          // A field that opens with a quote.
          const open = pos;
          const openLine = line;
          pos += 1;
          value = '';
          let closed = false;
          let segStart = pos;
          let firstSeg = true;
          while (true) {
            const q = text.indexOf('"', pos);
            if (q === -1) {
              pos = n;
              break;
            }
            if (text.charCodeAt(q + 1) === 34) {
              // Doubled quote: one quote in the value.
              const seg = convertSegment(segStart, q);
              if (firstSeg) {
                value = seg;
                firstSeg = false;
              } else value += seg;
              value += '"';
              pos = q + 2;
              segStart = q + 2;
              continue;
            }
            const seg = convertSegment(segStart, q);
            if (firstSeg) value = seg;
            else value += seg;
            pos = q + 1;
            closed = true;
            break;
          }
          if (!closed) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            readUnquoted('"');
            value = uValue;
            done = uEnded;
          } else if (pos >= n) {
            done = END;
          } else {
            const c = text.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              done = COMMA;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              done = LINE_BREAK;
            } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              done = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands.
              readUnquoted(value);
              if (uAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              value = uValue;
              done = uEnded;
            }
          }
        } else {
          readUnquoted('');
          value = uValue;
          done = uEnded;
        }
        fields.push(value);
        if (done !== COMMA) ended = true;
      }
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
