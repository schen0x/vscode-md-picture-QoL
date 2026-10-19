import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type * as vscode from 'vscode';
import { decode } from 'jpeg-js';
import { PicturePasteProvider } from '../src/paste';
import { imageLinks } from '../src/core';
import * as mock from './uiMock';
import { samplePng } from './imageFixture';

function setup() {
  mock.reset();
  const document = {
    uri: new mock.Uri('/workspace/note.md'), isUntitled: false, isClosed: false,
    languageId: 'markdown', version: 1,
  } as unknown as vscode.TextDocument;
  const source = new mock.CancellationTokenSource();
  const context = { triggerKind: 0, only: undefined } as vscode.DocumentPasteEditContext;
  const transfer = (data: () => Promise<Uint8Array>) => new Map([
    ['image/png', { asFile: () => ({ name: 'clipboard.png', data }) }],
  ]) as unknown as vscode.DataTransfer;
  const provider = new PicturePasteProvider();
  const paste = (data: () => Promise<Uint8Array>) => provider.provideDocumentPasteEdits(document, [], transfer(data), context, source.token);
  return { document, source, paste };
}

test('default paste prepares matching JPEG bytes and Markdown in one unapplied edit', async () => {
  const { paste } = setup();
  const edits = await paste(async () => samplePng());
  assert.equal(edits?.length, 1);
  const edit = edits![0]!;
  const link = imageLinks(String(edit.insertText))[0]!;
  assert.match(link.url, /^\.\/image-.*\.jpg$/);
  const operations = edit.additionalEdit as unknown as mock.WorkspaceEdit;
  const [uri, options] = operations.creations[0]!;
  assert.equal(uri.path, '/workspace/' + link.url.slice(2));
  assert.equal(options.overwrite, false);
  assert.equal(decode(options.contents).width, 128);
  assert.equal(mock.applied.length, 0, 'Provider must not apply file or text edits');
});

test('paste respects original-byte opt-out and configured output directory', async () => {
  const { paste } = setup();
  mock.config.convertToJpeg = false;
  mock.config.pasteDirectory = './images';
  const bytes = samplePng();
  const edit = (await paste(async () => bytes))![0]!;
  const [uri, options] = (edit.additionalEdit as unknown as mock.WorkspaceEdit).creations[0]!;
  assert.match(uri.path, /^\/workspace\/images\/image-.*\.png$/);
  assert.deepEqual(options.contents, bytes);
  assert.match(String(edit.insertText), /\.\/images\/image-.*\.png/);
});

test('paste quality configuration reaches the encoder', async () => {
  const { paste } = setup();
  const bytes = samplePng();
  const sizes: number[] = [];
  for (const quality of ['high', 'low']) {
    mock.config.jpegQuality = quality;
    const edit = (await paste(async () => bytes))![0]!;
    sizes.push((edit.additionalEdit as unknown as mock.WorkspaceEdit).creations[0]![1].contents.length);
  }
  assert.ok(sizes[0]! > sizes[1]!);
});

test('conversion errors and cancellation return no partial paste edits', async () => {
  const { paste, source } = setup();
  assert.equal(await paste(async () => Buffer.from('broken PNG')), undefined);
  assert.match(mock.errors[0]!, /Could not convert PNG to JPEG/);
  const pending = paste(async () => {
    await source.cancel();
    return samplePng();
  });
  assert.equal(await pending, undefined);
  assert.equal(mock.errors.length, 1, 'Cancellation must stay silent');
  assert.equal(mock.applied.length, 0);
});

test('a changed or closed note cannot receive a stale asynchronous paste', async () => {
  for (const key of ['version', 'isClosed'] as const) {
    const { paste, document } = setup();
    assert.equal(await paste(async () => {
      Object.assign(document, key === 'version' ? { version: 2 } : { isClosed: true });
      return samplePng();
    }), undefined);
    assert.equal(mock.applied.length, 0);
  }
});

test('paste rejects escaping and absolute directories before reading clipboard bytes', async () => {
  const { paste } = setup();
  let reads = 0;
  for (const directory of [
    '..', '../workspace-other/images', '..\\outside', '/outside',
    'C:\\outside', '\\\\server\\share\\outside', 'file:///outside',
  ]) {
    mock.config.pasteDirectory = directory;
    assert.equal(await paste(async () => { reads++; return samplePng(); }), undefined, directory);
  }
  assert.equal(reads, 0);
  assert.equal(mock.errors.length, 7);
  assert.equal(mock.applied.length, 0);
});

test('paste rejects symlink destination ancestors and standalone notes', async () => {
  const { paste } = setup();
  mock.config.pasteDirectory = './linked/missing';
  mock.fileTypes.set('/workspace/linked', mock.FileType.Directory | mock.FileType.SymbolicLink);
  assert.equal(await paste(async () => samplePng()), undefined);
  assert.match(mock.errors[0]!, /symbolic links/);
  mock.config.pasteDirectory = '.';
  mock.workspaceRoots.length = 0;
  assert.equal(await paste(async () => samplePng()), undefined);
  assert.match(mock.errors[1]!, /workspace folder/);
  assert.equal(mock.applied.length, 0);
});

test('paste allows parent-relative directories inside the workspace', async () => {
  const { paste, document } = setup();
  Object.assign(document, { uri: new mock.Uri('/workspace/notes/note.md') });
  mock.config.convertToJpeg = false;
  mock.config.pasteDirectory = '../images';
  const edits = await paste(async () => samplePng());
  const [uri] = (edits![0]!.additionalEdit as unknown as mock.WorkspaceEdit).creations[0]!;
  assert.match(uri.path, /^\/workspace\/images\/image-.*\.png$/);
});
