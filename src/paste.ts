import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';
import { availableName, imageExtension, imageMarkdown, mimeExtensions, normalizeDirectory } from './core';
import { checkParent, checkWorkspacePath, isMarkdownNote, relativeUri, settings, stat } from './files';
import { prepareImage } from './image';

export const picturePasteKind = vscode.DocumentDropOrPasteEditKind.Empty.append('markdown', 'link', 'image', 'pictureQol');
interface ClipboardImage { file: vscode.DataTransferFile; extension: string }

function clipboardImages(transfer: vscode.DataTransfer): ClipboardImage[] {
  const files = new Map<string, ClipboardImage>();
  const raw: ClipboardImage[] = [];
  for (const [mime, item] of transfer) {
    const file = item.asFile();
    if (!file) continue;
    const extension = mimeExtensions[mime.toLowerCase()] ?? imageExtension(file.name);
    if (!extension) continue;
    if (file.uri) files.set(file.uri.toString(), { file, extension });
    else if (mime.toLowerCase().startsWith('image/')) raw.push({ file, extension });
  }
  if (files.size) return [...files.values()];
  // A screenshot may appear in several formats. Store a single, preferably lossless, representation.
  const preferred = raw.find(image => image.extension === '.png') ?? raw[0];
  return preferred ? [preferred] : [];
}

export class PicturePasteProvider implements vscode.DocumentPasteEditProvider {
  async provideDocumentPasteEdits(
    document: vscode.TextDocument, _ranges: readonly vscode.Range[], transfer: vscode.DataTransfer,
    _context: vscode.DocumentPasteEditContext, token: vscode.CancellationToken,
  ): Promise<vscode.DocumentPasteEdit[] | undefined> {
    if (!vscode.workspace.isTrusted || !isMarkdownNote(document) || !settings(document).enabled || token.isCancellationRequested) return;
    const version = document.version;
    const images = clipboardImages(transfer);
    if (!images.length) return; // Normal text paste remains untouched.
    try {
      const config = settings(document);
      const directory = normalizeDirectory(config.pasteDirectory);
      await checkWorkspacePath(document, relativeUri(document, directory));
      const operations = new vscode.WorkspaceEdit();
      const reserved = new Set<string>();
      const snippets: string[] = [];
      for (const image of images) {
        if (token.isCancellationRequested) return;
        const original = await image.file.data();
        if (token.isCancellationRequested) return;
        if (!original.byteLength) throw new Error('The clipboard image is empty.');
        const prepared = await prepareImage(original, image.extension, config.convertToJpeg, config.jpegQuality, token);
        if (!prepared || token.isCancellationRequested) return;
        // UUIDs also separate concurrent paste operations; the existence check catches existing files.
        const base = `image-${randomUUID()}`;
        const relative = await availableName(directory, prepared.extension, async name =>
          reserved.has(name) || !!await stat(relativeUri(document, name)), base);
        const uri = relativeUri(document, relative);
        await checkWorkspacePath(document, uri);
        await checkParent(uri, config.createDirectories);
        if (token.isCancellationRequested) return;
        reserved.add(relative);
        operations.createFile(uri, { contents: prepared.contents, overwrite: false });
        snippets.push(imageMarkdown(path.normalize(relative)));
      }
      if (token.isCancellationRequested || document.version !== version || !isMarkdownNote(document) || !settings(document).enabled) return;
      const edit = new vscode.DocumentPasteEdit(snippets.join('\n'), 'Paste Image into Note', picturePasteKind);
      edit.additionalEdit = operations;
      return [edit];
    } catch (error) {
      if (!token.isCancellationRequested) void vscode.window.showErrorMessage(`Markdown Picture: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }
}
