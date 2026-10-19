import * as vscode from 'vscode';
import { imageExtension, imageLinks, localImagePath, type ImageLink } from './core';
import { isMarkdownNote, relativeUri, settings, stat } from './files';

export const highlightLimits = {
  delayMs: 20_000,
  editDelayMs: 5_000,
  documentBytes: 1024 * 1024,
  documentImages: 2048,
  visibleTargets: 256,
  concurrency: 4,
} as const;

interface IndexedImage extends ImageLink { target: vscode.Uri; key: string }
interface NoteState {
  document: vscode.TextDocument;
  generation: number;
  initial: boolean;
  index?: { version: number; images: IndexedImage[] };
  present: Set<string>;
  checked: Set<string>;
  pendingScan: boolean;
  imageEdit: boolean;
  timer?: vscode.Disposable;
}

type Schedule = (callback: () => Promise<void>, delayMs: number) => vscode.Disposable;
interface HighlightOptions {
  schedule?: Schedule;
  stat?: typeof stat;
  isWindowFocused?: () => boolean;
}
const scheduleTimeout: Schedule = (callback, delay) => {
  const timer = setTimeout(() => { void callback(); }, delay);
  return { dispose: () => clearTimeout(timer) };
};

/** Event-driven metadata checks. No polling, image decoding, HTTP, or filesystem watchers. */
export class ImageTagHighlighter implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('markdownPicture.imageTagForeground'),
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly notes = new Map<vscode.TextDocument, NoteState>();
  private readonly subscriptions: vscode.Disposable[];
  private readonly schedule: Schedule;
  private readonly readStat: typeof stat;
  private readonly isWindowFocused: () => boolean;
  // Serialize documents, so opening many notes never multiplies the filesystem concurrency.
  private work: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: HighlightOptions = {}) {
    this.schedule = options.schedule ?? scheduleTimeout;
    this.readStat = options.stat ?? stat;
    this.isWindowFocused = options.isWindowFocused ?? (() => vscode.window.state.focused);
    this.subscriptions = [
      vscode.workspace.onDidOpenTextDocument(document => {
        const state = this.ensure(document);
        if (state && this.visible(document)) this.request(state, 0);
      }),
      vscode.workspace.onDidCloseTextDocument(document => this.drop(document)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.editorsChanged()),
      vscode.window.onDidChangeTextEditorVisibleRanges(event => {
        const state = this.ensure(event.textEditor.document);
        if (state) this.request(state);
      }),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length) return;
        const state = this.ensure(event.document);
        if (!state) return;
        state.imageEdit ||= this.touchesImage(event, state);
        state.index = undefined;
        state.present.clear();
        state.checked.clear();
        this.paint(state);
        this.request(state, highlightLimits.delayMs, true);
      }),
      vscode.window.onDidChangeWindowState(() => this.editorsChanged()),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('markdownPicture')) return;
        for (const document of this.notes.keys()) this.drop(document);
        this.editorsChanged();
      }),
      vscode.workspace.onDidCreateFiles(() => this.filesChanged()),
      vscode.workspace.onDidDeleteFiles(() => this.filesChanged()),
      vscode.workspace.onDidRenameFiles(() => this.filesChanged()),
    ];
    this.editorsChanged();
  }

  dispose(): void {
    this.disposed = true;
    for (const document of this.notes.keys()) this.drop(document);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.decoration.dispose();
  }

  private enabled(document: vscode.TextDocument): boolean {
    return !this.disposed && vscode.workspace.isTrusted && isMarkdownNote(document)
      && settings(document).enabled
      && vscode.workspace.getConfiguration('markdownPicture', document.uri).get<boolean>('highlightImages', true);
  }

  private visible(document: vscode.TextDocument): boolean {
    return vscode.window.visibleTextEditors.some(editor => editor.document === document);
  }

  private ensure(document: vscode.TextDocument): NoteState | undefined {
    if (!this.enabled(document)) { this.drop(document); return; }
    let state = this.notes.get(document);
    if (!state) {
      state = { document, generation: 0, initial: true, pendingScan: false, imageEdit: false, present: new Set(), checked: new Set() };
      this.notes.set(document, state);
    }
    return state;
  }

  private drop(document: vscode.TextDocument): void {
    const state = this.notes.get(document);
    if (!state) return;
    state.generation++;
    state.timer?.dispose();
    state.index = undefined;
    state.present.clear();
    this.paint(state);
    this.notes.delete(document);
  }

  private editorsChanged(): void {
    for (const state of this.notes.values()) {
      if (!this.isWindowFocused() || !this.visible(state.document)) {
        state.generation++;
        state.timer?.dispose();
        state.timer = undefined;
        state.pendingScan = false;
      }
    }
    for (const editor of vscode.window.visibleTextEditors) {
      const state = this.ensure(editor.document);
      if (!state) continue;
      this.paint(state);
      this.request(state, state.initial ? 0 : highlightLimits.delayMs);
    }
  }

  private filesChanged(): void {
    for (const state of this.notes.values()) {
      state.present.clear();
      state.checked.clear();
      this.paint(state);
      // A companion create/rename event must not postpone the link edit's existing timer.
      if (state.imageEdit && state.timer) continue;
      this.request(state, highlightLimits.delayMs, true);
    }
  }

  private request(state: NoteState, delay: number = highlightLimits.delayMs, restart = false): void {
    // Viewport events must not postpone opening scans or the faster image-edit update.
    if (state.pendingScan && (state.initial || state.imageEdit) && !restart) return;
    const generation = ++state.generation;
    state.timer?.dispose();
    state.timer = undefined;
    state.pendingScan = false;
    if (!this.isWindowFocused() || !this.visible(state.document)) return;
    state.pendingScan = true;
    state.timer = this.schedule(() => {
      state.timer = undefined;
      this.work = this.work.then(() => this.scan(state, generation)).catch(() => {
        // A failed metadata check must never interfere with editing or show background popups.
        if (this.current(state, generation)) { state.present.clear(); this.paint(state); }
      }).finally(() => {
        if (state.generation === generation) state.pendingScan = false;
      });
      return this.work;
    }, state.imageEdit ? highlightLimits.editDelayMs : state.initial && !restart ? 0 : delay);
  }

  private touchesImage(event: vscode.TextDocumentChangeEvent, state: NoteState): boolean {
    // Use old AST offsets plus the changed line: no AST parsing on each keystroke.
    // The line check also catches newly typed/pasted tags and previously invalid destinations.
    if (event.document.offsetAt(new vscode.Position(event.document.lineCount, 0)) > highlightLimits.documentBytes) return false;
    return event.contentChanges.some(change => state.index?.images.some(image =>
      change.rangeOffset <= image.end && change.rangeOffset + change.rangeLength >= image.start)
      || change.text.includes('![')
      || event.document.getText(new vscode.Range(
        new vscode.Position(change.range.start.line, 0),
        new vscode.Position(change.range.start.line + 1, 0),
      )).includes('!['));
  }

  private current(state: NoteState, generation: number): boolean {
    return !this.disposed && this.notes.get(state.document) === state && state.generation === generation
      && !state.document.isClosed && this.isWindowFocused() && this.visible(state.document);
  }

  private index(document: vscode.TextDocument): IndexedImage[] {
    // Avoid retrieving or parsing a huge string, then apply an exact UTF-8 byte cap as well.
    if (document.offsetAt(new vscode.Position(document.lineCount, 0)) > highlightLimits.documentBytes) return [];
    const text = document.getText();
    if (Buffer.byteLength(text, 'utf8') > highlightLimits.documentBytes) return [];
    const links = imageLinks(text);
    if (links.length > highlightLimits.documentImages) return [];
    const images: IndexedImage[] = [];
    for (const link of links) {
      try {
        const relative = localImagePath(link.url);
        if (!imageExtension(relative)) continue;
        const target = relativeUri(document, relative);
        images.push({ ...link, target, key: target.toString() });
      } catch { /* Remote URLs, fragments, and unsupported paths are not checked. */ }
    }
    return images;
  }

  private async scan(state: NoteState, generation: number): Promise<void> {
    if (!this.current(state, generation)) return;
    const document = state.document;
    const version = document.version;
    if (state.index?.version !== version) state.index = { version, images: this.index(document) };
    const spans = vscode.window.visibleTextEditors.filter(editor => editor.document === document)
      .flatMap(editor => editor.visibleRanges.map(range => ({ start: document.offsetAt(range.start), end: document.offsetAt(range.end) })));
    const images = state.initial ? state.index.images : state.index.images.filter(image =>
      spans.some(span => image.start <= span.end && image.end >= span.start));
    const unique = new Map(images.map(image => [image.key, image.target]));
    const candidates = [...unique].filter(([key]) => !state.initial || !state.checked.has(key))
      .slice(0, state.initial ? highlightLimits.documentImages : highlightLimits.visibleTargets);
    let next = 0;
    const valid = () => this.current(state, generation) && document.version === version;
    await Promise.all(Array.from({ length: Math.min(highlightLimits.concurrency, candidates.length) }, async () => {
      while (valid()) {
        const candidate = candidates[next++];
        if (!candidate) return;
        const [key, target] = candidate;
        let exists = false;
        try {
          const info = await this.readStat(target);
          exists = info !== undefined && (info.type & vscode.FileType.File) !== 0;
        }
        catch { /* Missing, inaccessible, and offline files remain undecorated. */ }
        if (!valid()) return;
        if (state.initial) state.checked.add(key);
        if (exists) state.present.add(key);
        else state.present.delete(key);
      }
    }));
    if (valid()) { state.initial = false; state.imageEdit = false; state.checked.clear(); this.paint(state); }
  }

  private paint(state: NoteState): void {
    const document = state.document;
    const ranges = state.index?.version === document.version
      ? state.index.images.filter(image => state.present.has(image.key)).map(image =>
        new vscode.Range(document.positionAt(image.start), document.positionAt(image.end)))
      : [];
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === document) editor.setDecorations(this.decoration, ranges);
    }
  }
}
