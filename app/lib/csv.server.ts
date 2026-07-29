/**
 * RFC4180準拠の最小CSVパーサー。
 * Easify CSVは1フィールドが数MBになる場合があるため、正規表現split等は使わず
 * indexOf/sliceベースでスキャンする。
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const len = text.length;
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;

  while (i < len) {
    let field: string;

    if (text[i] === '"') {
      i++;
      let start = i;
      const parts: string[] = [];
      for (;;) {
        const qIdx = text.indexOf('"', i);
        if (qIdx === -1) {
          parts.push(text.slice(start));
          i = len;
          break;
        }
        if (text[qIdx + 1] === '"') {
          parts.push(text.slice(start, qIdx + 1));
          i = qIdx + 2;
          start = i;
          continue;
        }
        parts.push(text.slice(start, qIdx));
        i = qIdx + 1;
        break;
      }
      field = parts.join("");
    } else {
      const start = i;
      while (i < len && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
        i++;
      }
      field = text.slice(start, i);
    }

    row.push(field);

    if (i >= len) {
      rows.push(row);
      break;
    }

    const c = text[i];
    if (c === ",") {
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      if (text[i] === "\n") i++;
      rows.push(row);
      row = [];
      continue;
    }
    if (c === "\n") {
      i++;
      rows.push(row);
      row = [];
      continue;
    }
    // Malformed row (content after a closing quote before a delimiter): keep scanning.
  }

  // A trailing newline produces one bogus single-empty-field row; drop it.
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") {
      rows.pop();
    }
  }

  return rows;
}

export function rowsToRecords(rows: string[][]): {
  headers: string[];
  records: Record<string, string>[];
} {
  const [headers, ...dataRows] = rows;
  const records = dataRows
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""))
    .map((r) => {
      const record: Record<string, string> = {};
      headers.forEach((h, idx) => {
        record[h] = r[idx] ?? "";
      });
      return record;
    });
  return { headers, records };
}
