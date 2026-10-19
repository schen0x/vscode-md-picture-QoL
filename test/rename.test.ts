import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { PictureRenameController } from '../src/rename';
import { buildRenameEdit, checkWorkspacePath } from '../src/files';
import { imageLinks } from '../src/core';
import * as mock from './uiMock';

function setup(text = '![old](./old.png)', notePath = '/workspace/note.md') {
  mock.reset();
  const document = {
    uri: new mock.Uri(notePath), isUntitled: false, isClosed: false,
    languageId: 'markdown', version: 1,
    getText: () => text, offsetAt: (offset: number) => offset, positionAt: (offset: number) => offset,
  } as unknown as vscode.TextDocument;
  const editor = { document, selection: { active: 10 }, viewColumn: 1 } as unknown as vscode.TextEditor;
  mock.window.activeTextEditor = editor;
  const controller = new PictureRenameController();
  const done = controller.rename();
  return { controller, done, input: mock.lastInput, document, editor };
}

test('rename retains the draft while another application has focus', async () => {
  const { controller, done, input, editor } = setup();
  assert.equal(input.shown, true);
  assert.equal(input.ignoreFocusOut, true);
  await input.change('./img/remember this.png');
  mock.window.state.focused = false;
  await mock.selectionChange.fire({ textEditor: editor } as vscode.TextEditorSelectionChangeEvent);
  await mock.editorChange.fire(undefined);
  assert.equal(input.disposed, false);
  assert.equal(input.value, './img/remember this.png');
  assert.equal(mock.applied.length, 0);
  mock.window.state.focused = true;
  controller.dispose();
  await done;
});

test('clicking back in the editor cancels with no filesystem or document edits', async () => {
  const { done, input, editor } = setup();
  await input.change('./img/cancelled.png');
  await mock.selectionChange.fire({ textEditor: editor } as vscode.TextEditorSelectionChangeEvent);
  await done;
  assert.equal(input.disposed, true);
  assert.equal(mock.applied.length, 0);
});

test('Escape/hiding the rename input discards the draft', async () => {
  const { done, input } = setup();
  await input.change('./img/cancelled.png');
  await input.hide();
  await done;
  assert.equal(mock.applied.length, 0);
});

test('Enter moves the image and updates the note in one workspace edit', async () => {
  const { done, input } = setup();
  await input.change('./img/newName.png');
  await input.accept();
  await done;
  assert.equal(mock.applied.length, 1);
  assert.equal(mock.applied[0]!.moves.length, 1);
  assert.equal(mock.applied[0]!.replacements.length, 1);
  assert.equal(input.disposed, true);
});

test('invalid format keeps the rename open for correction', async () => {
  const { controller, done, input } = setup();
  await input.change('./img/photo.jpg');
  await input.accept();
  assert.match(input.validationMessage!, /does not convert/);
  assert.equal(input.disposed, false);
  assert.equal(input.enabled, true);
  assert.equal(mock.applied.length, 0);
  controller.dispose();
  await done;
});

test('a concurrent note edit cancels the stale rename', async () => {
  const { done, input, document } = setup();
  await input.change('./img/stale.png');
  await mock.documentChange.fire({ document, contentChanges: [{}] } as unknown as vscode.TextDocumentChangeEvent);
  await done;
  assert.equal(input.disposed, true);
  assert.equal(mock.applied.length, 0);
});

test('rename rejects workspace escapes and absolute destinations without applying edits', async () => {
  const { controller, done, input } = setup();
  for (const destination of [
    '../outside.png', '..\\outside.png', '../workspace-other/out.png',
    '/outside.png', 'C:\\outside.png', '\\\\server\\share\\outside.png', 'file:///outside.png',
  ]) {
    await input.change(destination);
    await input.accept();
    assert.ok(input.validationMessage, destination);
    assert.equal(mock.applied.length, 0, destination);
  }
  // Even another open workspace folder must not widen this note's boundary.
  mock.workspaceRoots.push(new mock.Uri('/other'));
  await input.change('../other/out.png');
  await input.accept();
  assert.match(input.validationMessage!, /stay inside/);
  controller.dispose();
  await done;
});

test('rename rejects outside or encoded absolute source links', async () => {
  for (const source of ['../outside.png', '%2E%2E/outside.png', '%2Foutside.png', 'C%3A%5Coutside.png', '%5C%5Cserver%5Cshare%5Coutside.png']) {
    const { controller, done, document } = setup(`![old](${source})`);
    await assert.rejects(buildRenameEdit(document, imageLinks(document.getText())[0]!, './safe.png'));
    assert.equal(mock.applied.length, 0);
    controller.dispose();
    await done;
  }
});

test('rename allows parent-relative moves that stay inside the workspace', async () => {
  const { controller, done, document } = setup('![old](../old.png)', '/workspace/notes/note.md');
  const edit = await buildRenameEdit(document, imageLinks(document.getText())[0]!, '../images/new.png');
  const [source, target] = (edit as unknown as mock.WorkspaceEdit).moves[0] as mock.Uri[];
  assert.equal(source!.path, '/workspace/old.png');
  assert.equal(target!.path, '/workspace/images/new.png');
  controller.dispose();
  await done;
});

test('rename rejects symlink sources and symlink destination ancestors', async () => {
  const { controller, done, document } = setup();
  const selected = imageLinks(document.getText())[0]!;
  mock.fileTypes.set('/workspace/linked', mock.FileType.Directory | mock.FileType.SymbolicLink);
  await assert.rejects(buildRenameEdit(document, selected, './linked/missing/new.png'), /symbolic links/);
  mock.fileTypes.set('/workspace/old.png', mock.FileType.File | mock.FileType.SymbolicLink);
  await assert.rejects(buildRenameEdit(document, selected, './safe.png'), /symbolic links/);
  assert.equal(mock.applied.length, 0);
  controller.dispose();
  await done;
});

test('workspace guard rejects standalone notes and mismatched URI origins', async () => {
  const { controller, done, document } = setup();
  for (const target of [
    new mock.Uri('/outside.png'),
    Object.assign(new mock.Uri('/workspace/new.png'), { scheme: 'vscode-remote', authority: 'ssh-remote+other' }),
  ]) {
    await assert.rejects(checkWorkspacePath(document, target as unknown as vscode.Uri), /stay inside/);
  }
  mock.workspaceRoots.length = 0;
  await assert.rejects(buildRenameEdit(document, imageLinks(document.getText())[0]!, './safe.png'), /workspace folder/);
  controller.dispose();
  await done;
});

test('workspace guard supports remote workspace URIs', async () => {
  const { controller, done, document } = setup();
  Object.assign(document.uri, { scheme: 'vscode-remote', authority: 'ssh-remote+host' });
  Object.assign(mock.workspaceRoots[0]!, { scheme: 'vscode-remote', authority: 'ssh-remote+host' });
  const edit = await buildRenameEdit(document, imageLinks(document.getText())[0]!, './new.png');
  const [source, target] = (edit as unknown as mock.WorkspaceEdit).moves[0] as mock.Uri[];
  assert.equal(source!.authority, 'ssh-remote+host');
  assert.equal(target!.scheme, 'vscode-remote');
  controller.dispose();
  await done;
});
