import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import stringWidth from 'string-width';
import { formatTables } from '../src/table';
import { formatSelectedTables } from '../src/tableCommand';

test('centers plain rows using ASCII spaces and preserves indentation', () => {
  assert.equal(formatTables('  | sth | sth2 | sth3 |\n  | longer | x | yy |'),
    '  |  sth   | sth2  | sth3  |\n  | :----: | :---: | :---: |\n  | longer |   x   |  yy   |');
});

test('formats delimiter rows, optional outer pipes, empty cells, and is idempotent', () => {
  const result = formatTables('Name | Value\n--- | ---:\n| A | |\nlong name | 42');
  assert.equal(result,
    '|   Name    | Value |\n| :-------: | :---: |\n|     A     |       |\n| long name |  42   |');
  assert.equal(formatTables(result), result);
});

test('inserts a header separator once and keeps every data row', () => {
  const result = formatTables('Name | Value\nA | 1\nB | 2');
  assert.equal(result,
    '| Name  | Value |\n| :---: | :---: |\n|   A   |   1   |\n|   B   |   2   |');
  assert.equal(formatTables(result), result);
});

test('uses the header indentation and original newline for an inserted separator', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    const result = formatTables(`\t| a | b |${newline}\t| c | d |${newline}`);
    assert.equal(result, [
      '\t|   a   |   b   |', '\t| :---: | :---: |', '\t|   c   |   d   |', '',
    ].join(newline));
    assert.equal(formatTables(result), result);
  }
});

test('preserves escaped pipes and uses backslash parity for delimiters', () => {
  const result = formatTables('| a\\|b | c |\n| \\\\| d |');
  assert.ok(result.includes('a\\|b'));
  assert.ok(result.includes('\\\\'));
  assert.equal(formatTables(result), result);
});

test('aligns CJK, combining marks, and emoji by display width', () => {
  const result = formatTables('| 日本語 | 👩‍💻 |\n| e\u0301 | hello |');
  const rows = result.split('\n');
  assert.equal(stringWidth(rows[0]!), stringWidth(rows[1]!));
  for (let column = 0; column < 2; column++) {
    assert.equal(stringWidth(rows[0]!.split('|')[column + 1]!), stringWidth(rows[1]!.split('|')[column + 1]!));
  }
  assert.ok(result.includes('e\u0301'));
});

test('keeps surrounding text, CRLF, trailing newline, and separate tables', () => {
  const source = 'Before\r\n| a | b |\r\n| ccc | d |\r\n\r\nAfter\r\n| x | y |\r\n| z | w |\r\n';
  const result = formatTables(source);
  assert.ok(result.startsWith('Before\r\n|   a   |   b   |\r\n| :---: | :---: |'));
  assert.ok(result.includes('\r\n\r\nAfter\r\n'));
  assert.ok(result.endsWith('|   z   |   w   |\r\n'));
  assert.equal(result.replace(/\r\n/g, '').includes('\n'), false);
});

test('leaves single rows, non-tables, and inconsistent column counts intact', () => {
  for (const text of ['prose', '| a | b |', '| a | b |\n| c | d | e |', '| only |\n| one |']) {
    assert.equal(formatTables(text), text);
  }
});

function editorFixture(text: string, selections: { start: { line: number; character: number }; end: { line: number; character: number }; isEmpty: boolean }[]) {
  const lines = text.split('\n');
  const edits: { range: vscode.Range; text: string }[] = [];
  let transactions = 0;
  const editor = {
    document: {
      languageId: 'markdown',
      lineAt: (line: number) => ({ range: { start: { line, character: 0 }, end: { line, character: lines[line]!.length } } }),
      getText: (range: vscode.Range) => lines.slice(range.start.line, range.end.line + 1).join('\n'),
    },
    selections,
    edit: async (callback: (builder: { replace: (range: vscode.Range, text: string) => void }) => void) => {
      transactions++;
      callback({ replace: (range, text) => edits.push({ range, text }) });
      return true;
    },
  } as unknown as vscode.TextEditor;
  return { editor, edits, transactions: () => transactions };
}

test('expands partial selections to whole lines and excludes next-line column zero', async () => {
  const fixture = editorFixture('before\n  | a | b |\n  | ccc | d |\nafter', [
    { start: { line: 1, character: 4 }, end: { line: 3, character: 0 }, isEmpty: false },
  ]);
  await formatSelectedTables(fixture.editor);
  assert.equal(fixture.transactions(), 1);
  assert.equal(fixture.edits[0]!.range.start.line, 1);
  assert.equal(fixture.edits[0]!.range.start.character, 0);
  assert.equal(fixture.edits[0]!.range.end.line, 2);
  assert.equal(fixture.edits[0]!.text, '  |   a   |   b   |\n  | :---: | :---: |\n  |  ccc  |   d   |');
});

test('merges overlapping selections into one edit and skips empty selections', async () => {
  const fixture = editorFixture('| a | b |\n| ccc | d |', [
    { start: { line: 0, character: 0 }, end: { line: 1, character: 8 }, isEmpty: false },
    { start: { line: 0, character: 3 }, end: { line: 1, character: 5 }, isEmpty: false },
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true },
  ]);
  await formatSelectedTables(fixture.editor);
  assert.equal(fixture.edits.length, 1);
  assert.equal(fixture.transactions(), 1);
});

test('does not edit without selected tables or outside Markdown', async () => {
  const selection = { start: { line: 0, character: 0 }, end: { line: 1, character: 9 }, isEmpty: false };
  const fixture = editorFixture('| a | b |\n| c | d |', [selection]);
  Object.defineProperty(fixture.editor.document, 'languageId', { value: 'plaintext' });
  await formatSelectedTables(fixture.editor);
  assert.equal(fixture.transactions(), 0);
  const empty = editorFixture('hello', []);
  await formatSelectedTables(empty.editor);
  assert.equal(empty.transactions(), 0);
});
