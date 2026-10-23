import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { buildRenameEdit, checkWorkspacePath, relativeUri, stat } from '../src/files';
import { symlink, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PicturePasteProvider } from '../src/paste';
import { imageLinks } from '../src/core';
import { ImageTagHighlighter, highlightLimits } from '../src/highlight';
import { decode } from 'jpeg-js';
import { samplePng } from './imageFixture';

const png = Uint8Array.from(samplePng());
const token = new vscode.CancellationTokenSource().token;

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, 'Test workspace must be open');
  const fixture = vscode.Uri.joinPath(root, 'fixtures');
  await vscode.workspace.fs.createDirectory(fixture);
  const config = vscode.workspace.getConfiguration('markdownPicture', root);
  await config.update('createDirectories', true, vscode.ConfigurationTarget.Workspace);
  await config.update('pasteDirectory', '.', vscode.ConfigurationTarget.Workspace);
  await config.update('enabled', true, vscode.ConfigurationTarget.Workspace);
  await config.update('highlightImages', true, vscode.ConfigurationTarget.Workspace);
  assert.equal(config.inspect('convertToJpeg')?.defaultValue, true);
  assert.equal(config.inspect('jpegQuality')?.defaultValue, 'medium');
  await config.update('convertToJpeg', false, vscode.ConfigurationTarget.Workspace);
  const noteUri = vscode.Uri.joinPath(fixture, 'note.md');
  await vscode.workspace.fs.writeFile(noteUri, Buffer.from('![old](./old.png) and ![again](./old.png "caption")\n`![code](./old.png)`'));
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(fixture, 'old.png'), png);
  const note = await vscode.workspace.openTextDocument(noteUri);
  await vscode.window.showTextDocument(note);
  const extension = vscode.extensions.getExtension('markdown-picture-qol.markdown-picture-qol');
  assert.ok(extension, 'Extension must be discovered');
  await extension.activate();
  assert.equal(vscode.workspace.getConfiguration('editor', note).get<string[]>('pasteAs.preferences')?.[0], 'markdown.link.image.pictureQol');

  const selected = imageLinks(note.getText())[0]!;
  const rename = await buildRenameEdit(note, selected, './img/newName.png');
  assert.equal(await stat(vscode.Uri.joinPath(fixture, 'img')), undefined, 'Preparing a move must not create folders');
  assert.equal(await vscode.workspace.applyEdit(rename), true);
  assert.equal(await stat(vscode.Uri.joinPath(fixture, 'old.png')), undefined);
  assert.deepEqual([...await vscode.workspace.fs.readFile(vscode.Uri.joinPath(fixture, 'img/newName.png'))], [...png]);
  assert.equal(note.getText(), '![newName](./img/newName.png) and ![newName](./img/newName.png "caption")\n`![code](./old.png)`');
  console.log('PASS: move, parent folder creation, alt text, repeated references, code exclusion');

  await vscode.commands.executeCommand('undo');
  assert.ok(await stat(vscode.Uri.joinPath(fixture, 'old.png')));
  assert.equal(await stat(vscode.Uri.joinPath(fixture, 'img/newName.png')), undefined);
  assert.equal(imageLinks(note.getText())[0]?.url, './old.png');
  console.log('PASS: one Undo restores the image and Markdown');

  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(fixture, 'taken.png'), png);
  await assert.rejects(buildRenameEdit(note, imageLinks(note.getText())[0]!, './taken.png'), /already exists/);
  assert.ok(await stat(vscode.Uri.joinPath(fixture, 'old.png')));
  assert.equal(imageLinks(note.getText())[0]?.url, './old.png');
  await config.update('createDirectories', false, vscode.ConfigurationTarget.Workspace);
  await assert.rejects(buildRenameEdit(note, imageLinks(note.getText())[0]!, './missing/deep/new.png'), /does not exist/);
  assert.equal(await stat(vscode.Uri.joinPath(fixture, 'missing')), undefined);
  console.log('PASS: collision protection and disabled folder creation');
  await config.update('createDirectories', true, vscode.ConfigurationTarget.Workspace);
  await checkPathGuards(note, root, fixture);

  const transfer = new vscode.DataTransfer();
  transfer.set('image/png', {
    value: undefined, asString: async () => '',
    asFile: () => ({ name: 'clipboard.png', data: async () => png }),
  });
  const provider = new PicturePasteProvider();
  const edits = await provider.provideDocumentPasteEdits(note, [new vscode.Range(0, 0, 0, 0)], transfer,
    { triggerKind: vscode.DocumentPasteTriggerKind.Automatic, only: undefined }, token);
  assert.equal(edits?.length, 1);
  const paste = edits![0]!;
  const inserted = String(paste.insertText);
  const pastedLink = imageLinks(inserted)[0]!;
  assert.ok(pastedLink);
  const pastedUri = relativeUri(note, pastedLink.url);
  assert.equal(await stat(pastedUri), undefined, 'Preparing paste must not create orphan files');
  const combined = paste.additionalEdit!;
  combined.insert(note.uri, new vscode.Position(0, 0), inserted + '\n');
  assert.equal(await vscode.workspace.applyEdit(combined), true);
  assert.deepEqual([...await vscode.workspace.fs.readFile(pastedUri)], [...png]);
  console.log('PASS: image paste creates the exact bytes and a rendered image tag');
  const second = await provider.provideDocumentPasteEdits(note, [], transfer, { triggerKind: vscode.DocumentPasteTriggerKind.Automatic, only: undefined }, token);
  assert.notEqual(String(second![0]!.insertText), inserted, 'Repeated pastes must use distinct filenames');

  await vscode.commands.executeCommand('undo');
  assert.equal(await stat(pastedUri), undefined);
  assert.equal(imageLinks(note.getText())[0]?.url, './old.png');
  console.log('PASS: paste Undo removes its file and tag together');
  await checkJpegPaste(note, fixture, provider, transfer);

  const otherUri = vscode.Uri.joinPath(fixture, 'other.txt');
  await vscode.workspace.fs.writeFile(otherUri, new Uint8Array());
  const other = await vscode.workspace.openTextDocument(otherUri);
  assert.equal(await provider.provideDocumentPasteEdits(other, [], transfer, { triggerKind: vscode.DocumentPasteTriggerKind.Automatic, only: undefined }, token), undefined);
  assert.equal(await provider.provideDocumentPasteEdits(note, [], new vscode.DataTransfer(), { triggerKind: vscode.DocumentPasteTriggerKind.Automatic, only: undefined }, token), undefined);
  const cancelled = new vscode.CancellationTokenSource();
  cancelled.cancel();
  assert.equal(await provider.provideDocumentPasteEdits(note, [], transfer, { triggerKind: vscode.DocumentPasteTriggerKind.Automatic, only: undefined }, cancelled.token), undefined);
  cancelled.dispose();
  await checkHighlighting(fixture);
  await checkTableFormatting();
  await config.update('enabled', false, vscode.ConfigurationTarget.Workspace);
  assert.equal(await provider.provideDocumentPasteEdits(note, [], transfer, { triggerKind: vscode.DocumentPasteTriggerKind.Automatic, only: undefined }, token), undefined);
  console.log('PASS: non-Markdown documents, text clipboard, cancellation, and disabled extension');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

async function checkTableFormatting(): Promise<void> {
  const original = 'Before\n  | a | b |\n  | longer | x |\nAfter\n';
  const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: original });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(1, 4, 3, 0);
  await vscode.commands.executeCommand('markdownQol.formatTable');
  // Text editor commands do not await promises returned by their callbacks.
  for (let attempt = 0; attempt < 100 && document.getText() === original; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(document.getText(), 'Before\n  |   a    |   b   |\n  | :----: | :---: |\n  | longer |   x   |\nAfter\n');
  await vscode.commands.executeCommand('undo');
  assert.equal(document.getText(), original, 'One Undo restores the selected table');
  console.log('PASS: registered table command, unsaved Markdown, partial selection, and Undo');
}

async function checkPathGuards(note: vscode.TextDocument, root: vscode.Uri, fixture: vscode.Uri): Promise<void> {
  const selected = imageLinks(note.getText())[0]!;
  await assert.rejects(buildRenameEdit(note, selected, '../../escape.png'), /stay inside/);
  await assert.rejects(buildRenameEdit(note, selected, vscode.Uri.joinPath(root, '..', 'escape.png').fsPath), /relative/);
  await buildRenameEdit(note, selected, '../inside.png');
  assert.equal(await stat(vscode.Uri.joinPath(root, 'inside.png')), undefined);

  if (process.platform === 'win32') {
    const target = vscode.Uri.joinPath(fixture, 'case-check.png');
    await checkWorkspacePath(note, target.with({ path: target.path.toUpperCase() }));
  }

  const linked = vscode.Uri.joinPath(fixture, 'linked');
  await symlink(dirname(root.fsPath), linked.fsPath, 'junction');
  try {
    await assert.rejects(buildRenameEdit(note, selected, './linked/missing/new.png'), /symbolic links/);
    await assert.rejects(checkWorkspacePath(note, vscode.Uri.joinPath(linked, 'missing/image.png')), /symbolic links/);
  } finally { await unlink(linked.fsPath); }
  // Windows file symlinks require Developer Mode or elevation; junctions above do not.
  if (process.platform !== 'win32') {
    const linkedSource = vscode.Uri.joinPath(fixture, 'linked-source.png');
    await symlink(vscode.Uri.joinPath(fixture, 'missing.png').fsPath, linkedSource.fsPath, 'file');
    try {
      await assert.rejects(checkWorkspacePath(note, linkedSource), /symbolic links/);
    } finally { await unlink(linkedSource.fsPath); }
  }
  console.log('PASS: workspace traversal, absolute paths, safe parent-relative moves, and real symlinks');
}

async function checkJpegPaste(note: vscode.TextDocument, fixture: vscode.Uri, provider: PicturePasteProvider, transfer: vscode.DataTransfer): Promise<void> {
  const config = vscode.workspace.getConfiguration('markdownPicture', note);
  await config.update('convertToJpeg', true, vscode.ConfigurationTarget.Workspace);
  await config.update('jpegQuality', 'medium', vscode.ConfigurationTarget.Workspace);
  await config.update('pasteDirectory', './converted/deep', vscode.ConfigurationTarget.Workspace);
  const before = note.getText();
  const edits = await provider.provideDocumentPasteEdits(note, [], transfer,
    { triggerKind: vscode.DocumentPasteTriggerKind.Automatic, only: undefined }, token);
  assert.equal(edits?.length, 1);
  const edit = edits![0]!;
  const inserted = String(edit.insertText);
  const link = imageLinks(inserted)[0]!;
  assert.match(link.url, /^\.\/converted\/deep\/image-.*\.jpg$/);
  const uri = relativeUri(note, link.url);
  assert.equal(await stat(vscode.Uri.joinPath(fixture, 'converted')), undefined, 'Conversion must not create folders or files during preparation');
  edit.additionalEdit!.insert(note.uri, new vscode.Position(0, 0), inserted + '\n');
  assert.equal(await vscode.workspace.applyEdit(edit.additionalEdit!), true);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const decoded = decode(bytes);
  assert.equal(decoded.width, 128);
  assert.equal(decoded.height, 96);
  assert.ok(bytes.byteLength < png.byteLength, 'Converted detailed image should be smaller');
  await vscode.commands.executeCommand('undo');
  assert.equal(await stat(uri), undefined);
  assert.equal(note.getText(), before);
  await vscode.commands.executeCommand('redo');
  assert.deepEqual(await vscode.workspace.fs.readFile(uri), bytes, 'Redo must restore the encoded JPEG bytes');
  assert.equal(imageLinks(note.getText())[0]!.url, link.url);
  const move = await buildRenameEdit(note, imageLinks(note.getText())[0]!, './converted/renamed.jpg');
  assert.equal(await vscode.workspace.applyEdit(move), true);
  assert.deepEqual(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(fixture, 'converted/renamed.jpg')), bytes);
  await vscode.commands.executeCommand('undo');
  await vscode.commands.executeCommand('undo');
  assert.equal(note.getText(), before);
  assert.equal(await stat(uri), undefined);
  await config.update('pasteDirectory', '.', vscode.ConfigurationTarget.Workspace);
  console.log('PASS: JPEG conversion, nested paste folders, matching link/bytes, grouped Undo/Redo, and F2 move');
}

async function checkHighlighting(fixture: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.joinPath(fixture, 'highlight.md');
  await vscode.workspace.fs.writeFile(uri, Buffer.from([
    '![existing](./old.png) ![again](./old.png)',
    '![missing](./missing.png) ![directory](./directory.png)',
    '`![code](./code.png)` ![web](https://example.com/web.png)',
  ].join('\n')));
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fixture, 'directory.png'));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const pending = new Map<number, { callback: () => Promise<void>; delay: number }>();
  const checks = new Map<string, vscode.FileStat | undefined>();
  let next = 0;
  const highlighter = new ImageTagHighlighter({
    // Desktop CI does not guarantee OS window focus, even after showTextDocument.
    // Unit tests cover focus gating; keep real editor/document/filesystem events here.
    isWindowFocused: () => true,
    schedule: (callback, delay) => {
      const id = ++next;
      pending.set(id, { callback, delay });
      return { dispose: () => { pending.delete(id); } };
    },
    stat: async target => {
      const info = await stat(target);
      checks.set(target.toString(), info);
      return info;
    },
  });
  const flush = async () => {
    const jobs = [...pending.values()];
    pending.clear();
    await Promise.all(jobs.map(job => job.callback()));
  };
  try {
    assert.ok(pending.size, 'Visible note must schedule its opening pass');
    assert.equal([...pending.values()][0]!.delay, 0);
    await flush();
    assert.equal(checks.size, 3, 'Only distinct local inline image targets are checked');
    // VS Code can normalize the opened document's drive casing on Windows.
    // Resolve expected keys from that document, just as the highlighter does.
    const checked = (relative: string) => {
      const key = relativeUri(document, relative).toString();
      assert.ok(checks.has(key), `Expected a metadata check for ${key}; checked: ${[...checks.keys()].join(', ')}`);
      return checks.get(key);
    };
    assert.equal(checked('./old.png')?.type, vscode.FileType.File);
    assert.equal(checked('./directory.png')?.type, vscode.FileType.Directory);
    assert.equal(checked('./missing.png'), undefined);
    assert.equal(pending.size, 0, 'No idle polling');
    const changed = new Promise<void>(resolve => {
      const subscription = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== document || !event.contentChanges.length) return;
        subscription.dispose(); resolve();
      });
    });
    assert.equal(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), 'prefix ')), true);
    await changed;
    assert.equal([...pending.values()][0]!.delay, highlightLimits.editDelayMs);
    await flush(); // Exercises real document positions, visible ranges, metadata, and decorations.
    const disabled = new Promise<void>(resolve => {
      const subscription = vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('markdownPicture.highlightImages', uri)) return;
        subscription.dispose(); resolve();
      });
    });
    const config = vscode.workspace.getConfiguration('markdownPicture', uri);
    await config.update('highlightImages', false, vscode.ConfigurationTarget.Workspace);
    await disabled;
    assert.equal(pending.size, 0);
    await config.update('highlightImages', true, vscode.ConfigurationTarget.Workspace);
  } finally {
    highlighter.dispose();
  }
  assert.equal(pending.size, 0, 'Disposal cancels scheduled work');
  console.log('PASS: highlighting activation, real ranges/files, deduplication, delayed edits, disable, and disposal');
}
