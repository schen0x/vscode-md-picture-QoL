// A small VS Code boundary double: the real filesystem/edit behavior is covered in Electron.
import type * as VSCode from 'vscode';
import { posix as path } from 'node:path';

class EventSource<T> {
  private listeners = new Set<(event: T) => unknown>();
  event = (listener: (event: T) => unknown) => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  async fire(value: T) { await Promise.all([...this.listeners].map(listener => listener(value))); }
}
export class Uri {
  scheme = 'file'; authority = ''; query = ''; fragment = '';
  constructor(public path: string) {}
  get fsPath() {
    if (process.platform !== 'win32' || this.scheme !== 'file') return this.path;
    const local = /^\/[a-z]:/i.test(this.path) ? this.path.slice(1) : `C:${this.path}`;
    return (this.authority ? `//${this.authority}${this.path}` : local).replace(/\//g, '\\');
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return Object.assign(new Uri(path.join(base.path, ...parts)), { scheme: base.scheme, authority: base.authority });
  }
  toString() { return `${this.scheme}://${this.authority}${this.path}`; }
}
export class Position { constructor(public line: number, public character: number) {} }
export class Range { constructor(public start: Position, public end: Position) {} }
export class ThemeColor { constructor(public id: string) {} }
export const DecorationRangeBehavior = { ClosedClosed: 1 };
export class Decoration {
  disposed = false;
  constructor(public options: VSCode.DecorationRenderOptions) {}
  dispose() { this.disposed = true; }
}
export let decorations: Decoration[] = [];
export class WorkspaceEdit {
  moves: unknown[] = []; replacements: unknown[] = [];
  creations: [Uri, { contents: Uint8Array; overwrite: boolean }][] = [];
  createFile(uri: Uri, options: { contents: Uint8Array; overwrite: boolean }) { this.creations.push([uri, options]); }
  renameFile(...args: unknown[]) { this.moves.push(args); }
  replace(...args: unknown[]) { this.replacements.push(args); }
}
export class DocumentDropOrPasteEditKind {
  static Empty = new DocumentDropOrPasteEditKind('');
  constructor(public value: string) {}
  append(...parts: string[]) { return new DocumentDropOrPasteEditKind([this.value, ...parts].filter(Boolean).join('.')); }
}
export class DocumentPasteEdit {
  additionalEdit?: WorkspaceEdit;
  constructor(public insertText: string, public title: string, public kind: DocumentDropOrPasteEditKind) {}
}
export class CancellationTokenSource {
  private cancelled = new EventSource<void>();
  token = { isCancellationRequested: false, onCancellationRequested: this.cancelled.event };
  cancel() { this.token.isCancellationRequested = true; return this.cancelled.fire(); }
}
export class FileSystemError extends Error { constructor(public code: string) { super(code); } }
export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
export let workspaceRoots: Uri[] = [new Uri('/workspace')];
export const fileTypes = new Map<string, number>();
export const selectionChange = new EventSource<VSCode.TextEditorSelectionChangeEvent>();
export const editorChange = new EventSource<VSCode.TextEditor | undefined>();
export const documentChange = new EventSource<VSCode.TextDocumentChangeEvent>();
export const documentClose = new EventSource<VSCode.TextDocument>();
export const documentOpen = new EventSource<VSCode.TextDocument>();
export const visibleEditorsChange = new EventSource<VSCode.TextEditor[]>();
export const visibleRangesChange = new EventSource<VSCode.TextEditorVisibleRangesChangeEvent>();
export const windowChange = new EventSource<VSCode.WindowState>();
export const configChange = new EventSource<VSCode.ConfigurationChangeEvent>();
export const fileCreate = new EventSource<VSCode.FileCreateEvent>();
export const fileDelete = new EventSource<VSCode.FileDeleteEvent>();
export const fileRename = new EventSource<VSCode.FileRenameEvent>();
export let config: Record<string, unknown> = {};
export class Input {
  title = ''; prompt = ''; placeholder = ''; value = ''; ignoreFocusOut = false;
  valueSelection: [number, number] | undefined;
  validationMessage: string | undefined;
  busy = false; enabled = true; disposed = false; shown = false;
  private hideEvent = new EventSource<void>();
  private changeEvent = new EventSource<string>();
  private acceptEvent = new EventSource<void>();
  onDidHide = this.hideEvent.event;
  onDidChangeValue = this.changeEvent.event;
  onDidAccept = this.acceptEvent.event;
  show() { this.shown = true; }
  dispose() { this.disposed = true; }
  hide() { return this.hideEvent.fire(); }
  async change(value: string) { this.value = value; await this.changeEvent.fire(value); }
  accept() { return this.acceptEvent.fire(); }
}
export let lastInput: Input;
export let applied: WorkspaceEdit[] = [];
export let fallbackCalls: string[] = [];
export let errors: string[] = [];
export const window = {
  activeTextEditor: undefined as VSCode.TextEditor | undefined,
  visibleTextEditors: [] as VSCode.TextEditor[],
  state: { focused: true },
  createTextEditorDecorationType: (options: VSCode.DecorationRenderOptions) => {
    const decoration = new Decoration(options);
    decorations.push(decoration);
    return decoration;
  },
  onDidChangeVisibleTextEditors: visibleEditorsChange.event,
  onDidChangeTextEditorVisibleRanges: visibleRangesChange.event,
  onDidChangeWindowState: windowChange.event,
  createInputBox: () => lastInput = new Input(),
  onDidChangeTextEditorSelection: selectionChange.event,
  onDidChangeActiveTextEditor: editorChange.event,
  showErrorMessage: async (text: string) => { errors.push(text); return undefined; },
  showTextDocument: async (_document: unknown, _options: unknown) => undefined,
};
export const workspace = {
  isTrusted: true,
  getWorkspaceFolder: (uri: Uri) => {
    const root = workspaceRoots.filter(root => root.scheme === uri.scheme && root.authority === uri.authority
      && (uri.path === root.path || uri.path.startsWith(root.path + '/')))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return root ? { uri: root } : undefined;
  },
  getConfiguration: () => ({ get: (key: string, fallback: unknown) => config[key] ?? fallback }),
  onDidOpenTextDocument: documentOpen.event,
  onDidChangeConfiguration: configChange.event,
  onDidCreateFiles: fileCreate.event,
  onDidDeleteFiles: fileDelete.event,
  onDidRenameFiles: fileRename.event,
  onDidChangeTextDocument: documentChange.event,
  onDidCloseTextDocument: documentClose.event,
  fs: { stat: async (uri: Uri) => {
    if (fileTypes.has(uri.path)) return { type: fileTypes.get(uri.path)! };
    if (uri.path === '/workspace/old.png') return { type: FileType.File };
    if (uri.path === '/workspace' || uri.path === '/') return { type: FileType.Directory };
    throw new FileSystemError('FileNotFound');
  } },
  applyEdit: async (edit: WorkspaceEdit) => { applied.push(edit); return true; },
};
export const commands = { executeCommand: async (command: string) => { fallbackCalls.push(command); } };
export function reset() {
  applied = []; fallbackCalls = []; errors = [];
  window.state.focused = true;
  window.activeTextEditor = undefined;
  window.visibleTextEditors = [];
  config = {}; decorations = [];
  workspace.isTrusted = true;
  workspaceRoots = [new Uri('/workspace')];
  fileTypes.clear();
}
