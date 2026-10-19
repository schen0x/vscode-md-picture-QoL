import * as vscode from 'vscode';
import { posix as path } from 'node:path';
import { imageLinks, imageMarkdown, localImagePath, imageExtension, normalizeDestination, type ImageLink } from './core';
import type { JpegQuality } from './image';

export function isMarkdownNote(document: vscode.TextDocument): boolean {
  return !document.isUntitled && !document.isClosed
    && ['file', 'vscode-remote'].includes(document.uri.scheme)
    && document.languageId === 'markdown' && /\.md$/i.test(document.uri.path);
}

export function settings(document: vscode.TextDocument) {
  const config = vscode.workspace.getConfiguration('markdownPicture', document.uri);
  return {
    enabled: config.get<boolean>('enabled', true),
    pasteDirectory: config.get<string>('pasteDirectory', '.'),
    createDirectories: config.get<boolean>('createDirectories', true),
    convertToJpeg: config.get<boolean>('convertToJpeg', true),
    jpegQuality: config.get<JpegQuality>('jpegQuality', 'medium'),
  };
}

export function relativeUri(document: vscode.TextDocument, relative: string): vscode.Uri {
  return vscode.Uri.joinPath(document.uri, '..', relative);
}

export async function stat(uri: vscode.Uri): Promise<vscode.FileStat | undefined> {
  try { return await vscode.workspace.fs.stat(uri); }
  catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return;
    throw error;
  }
}

/** Keep image operations in the note's workspace folder, including through existing parents. */
export async function checkWorkspacePath(document: vscode.TextDocument, target: vscode.Uri): Promise<void> {
  const root = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
  if (!root) throw new Error('Open the Markdown note in a workspace folder before creating or renaming images.');
  const relative = path.relative(root.path, target.path);
  if (target.scheme !== root.scheme || target.authority !== root.authority
    || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('Image paths must stay inside the Markdown note\'s workspace folder.');
  }
  // Walk from the root so we never follow a symlink while checking a deeper path.
  // The workspace root itself may be a symlink explicitly opened by the user.
  let current = root;
  for (const segment of relative.split('/').filter(Boolean)) {
    current = vscode.Uri.joinPath(current, segment);
    const existing = await stat(current);
    if (existing && (existing.type & vscode.FileType.SymbolicLink)) {
      throw new Error('Image paths cannot use symbolic links inside the workspace folder.');
    }
    if (!existing) break; // A missing ancestor cannot contain any existing descendants.
  }
}

/** Validate without creating folders: cancelled previews must leave no files behind. */
export async function checkParent(target: vscode.Uri, allowCreation: boolean): Promise<void> {
  let parent = vscode.Uri.joinPath(target, '..');
  for (;;) {
    const existing = await stat(parent);
    if (existing) {
      if (!(existing.type & vscode.FileType.Directory)) throw new Error('The destination parent is a file, not a folder.');
      return;
    }
    if (!allowCreation) throw new Error('The destination folder does not exist. Enable markdownPicture.createDirectories or create it first.');
    const next = vscode.Uri.joinPath(parent, '..');
    if (next.toString() === parent.toString()) throw new Error('The destination filesystem root does not exist.');
    parent = next;
  }
}

export async function buildRenameEdit(document: vscode.TextDocument, selected: ImageLink, input: string): Promise<vscode.WorkspaceEdit> {
  if (!isMarkdownNote(document) || !settings(document).enabled) throw new Error('Open an enabled, saved .md document first.');
  const version = document.version;
  const original = localImagePath(selected.url);
  const extension = imageExtension(original);
  if (!extension) throw new Error('The link must point to a supported image file.');
  const destination = normalizeDestination(input, extension);
  const sourceUri = relativeUri(document, original);
  const targetUri = relativeUri(document, destination);
  await checkWorkspacePath(document, sourceUri);
  await checkWorkspacePath(document, targetUri);
  const sourceStat = await stat(sourceUri);
  if (!sourceStat || !(sourceStat.type & vscode.FileType.File)) throw new Error('The original image file could not be found.');
  const samePath = sourceUri.toString() === targetUri.toString();
  if (!samePath && await stat(targetUri)) throw new Error('A file or folder already exists at this destination. Choose another name.');
  await checkParent(targetUri, settings(document).createDirectories);
  if (document.version !== version || document.isClosed) throw new Error('The note changed while the rename was being prepared. Try again.');
  const edit = new vscode.WorkspaceEdit();
  // VS Code creates parent folders as part of the move and groups the move and text edits for Undo.
  if (!samePath) edit.renameFile(sourceUri, targetUri, { overwrite: false });
  for (const link of imageLinks(document.getText())) {
    try {
      if (relativeUri(document, localImagePath(link.url)).toString() !== sourceUri.toString()) continue;
    } catch { continue; }
    edit.replace(document.uri, new vscode.Range(document.positionAt(link.start), document.positionAt(link.end)), imageMarkdown(destination, link.title));
  }
  return edit;
}

export function displayPath(relative: string): string {
  return relative.startsWith('../') ? relative : `./${path.normalize(relative)}`;
}
