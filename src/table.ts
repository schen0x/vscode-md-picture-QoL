import stringWidth from 'string-width';

interface Row { indent: string; cells: string[] }

function parseRow(line: string): Row | undefined {
  const indent = /^[\t ]*/.exec(line)![0];
  const text = line.slice(indent.length).trimEnd();
  const cells: string[] = [];
  let start = 0;
  let backslashes = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '|' && backslashes % 2 === 0) {
      cells.push(text.slice(start, i).trim());
      start = i + 1;
    }
    backslashes = character === '\\' ? backslashes + 1 : 0;
  }
  if (!cells.length) return undefined;
  cells.push(text.slice(start).trim());
  if (text.startsWith('|')) cells.shift();
  if (start === text.length) cells.pop();
  return cells.length >= 2 ? { indent, cells } : undefined;
}

const isSeparator = (row: Row): boolean => row.cells.every(cell => /^:?-{3,}:?$/.test(cell));
const width = (text: string): number => stringWidth(text, { countAnsiEscapeCodes: true });

/** Format contiguous, rectangular table blocks; leave other selected text intact. */
export function formatTables(text: string): string {
  // Keep original line endings, including a final newline.
  const parts = text.split(/(\r\n|\n|\r)/);
  for (let index = 0; index < parts.length;) {
    const rows: Row[] = [];
    let end = index;
    while (end < parts.length) {
      const row = parseRow(parts[end]!);
      if (!row) break;
      rows.push(row);
      end += 2;
    }
    const columns = rows[0]?.cells.length ?? 0;
    if (rows.length >= 2 && rows.every(row => row.cells.length === columns)) {
      // Centered delimiter cells need two colons and at least three hyphens.
      const widths = Array.from({ length: columns }, (_, column) =>
        Math.max(5, ...rows.filter(row => !isSeparator(row)).map(row => width(row.cells[column]!))));
      rows.forEach((row, offset) => {
        const separator = isSeparator(row);
        const cells = row.cells.map((cell, column) => {
          const size = widths[column]!;
          if (separator) return `:${'-'.repeat(size - 2)}:`;
          const padding = size - width(cell);
          return ' '.repeat(Math.floor(padding / 2)) + cell + ' '.repeat(Math.ceil(padding / 2));
        });
        parts[index + offset * 2] = `${row.indent}| ${cells.join(' | ')} |`;
      });
      if (!isSeparator(rows[0]!) && !isSeparator(rows[1]!)) {
        const cells = widths.map(size => `:${'-'.repeat(size - 2)}:`);
        parts[index] += `${parts[index + 1]}${rows[0]!.indent}| ${cells.join(' | ')} |`;
      }
    }
    index = end > index ? end : index + 2;
  }
  return parts.join('');
}
