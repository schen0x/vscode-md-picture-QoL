import * as vscode from 'vscode';
import { formatTables } from './table';

export async function formatSelectedTables(editor: vscode.TextEditor): Promise<void> {
  if (editor.document.languageId !== 'markdown') return;
  const spans = editor.selections.filter(selection => !selection.isEmpty).map(selection => ({
    start: selection.start.line,
    end: selection.end.line - (selection.end.character === 0 ? 1 : 0),
  })).sort((a, b) => a.start - b.start);
  const merged: typeof spans = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  const replacements = merged.map(span => {
    const range = new vscode.Range(editor.document.lineAt(span.start).range.start,
      editor.document.lineAt(span.end).range.end);
    const original = editor.document.getText(range);
    return { range, original, formatted: formatTables(original) };
  }).filter(edit => edit.original !== edit.formatted);
  if (!replacements.length) return;
  await editor.edit(builder => {
    for (const edit of replacements) builder.replace(edit.range, edit.formatted);
  });
}
