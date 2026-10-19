import { strict as assert } from 'node:assert';
import { test, type TestContext } from 'node:test';
import type * as vscode from 'vscode';
import { ImageTagHighlighter, highlightLimits } from '../src/highlight';
import * as mock from './uiMock';

type Check = (uri: vscode.Uri) => Promise<vscode.FileStat | undefined>;
const file = { type: mock.FileType.File, ctime: 0, mtime: 0, size: 1 };
const directory = { ...file, type: mock.FileType.Directory };
class Clock {
  now = 0;
  private next = 0;
  jobs = new Map<number, { due: number; callback: () => Promise<void> }>();
  schedule = (callback: () => Promise<void>, delay: number) => {
    const id = ++this.next;
    this.jobs.set(id, { due: this.now + delay, callback });
    return { dispose: () => { this.jobs.delete(id); } };
  };
  advance(ms: number): Promise<void[]> {
    this.now += ms;
    const jobs = [...this.jobs].filter(([, job]) => job.due <= this.now);
    return Promise.all(jobs.map(([id, job]) => { this.jobs.delete(id); return job.callback(); }));
  }
}
function note(text: string, name = 'note.md') {
  const model = { text, reads: 0, version: 1, isClosed: false };
  function positionAt(offset: number) {
    const lines = model.text.slice(0, offset).split('\n');
    return new mock.Position(lines.length - 1, lines.at(-1)!.length);
  }
  function offsetAt(position: vscode.Position) {
    const lines = model.text.split('\n');
    if (position.line >= lines.length) return model.text.length;
    return lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
  }
  const document = {
    uri: new mock.Uri(`/workspace/${name}`), isUntitled: false, languageId: 'markdown',
    get version() { return model.version; }, get isClosed() { return model.isClosed; },
    get lineCount() { return model.text.split('\n').length; },
    getText: (range?: vscode.Range) => {
      model.reads++;
      return range ? model.text.slice(offsetAt(range.start), offsetAt(range.end)) : model.text;
    }, positionAt, offsetAt,
  } as unknown as vscode.TextDocument;
  const view = { ranges: [] as vscode.Range[] };
  const editor = {
    document,
    visibleRanges: [new mock.Range(positionAt(0), positionAt(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n')))],
    setDecorations: (_type: vscode.TextEditorDecorationType, ranges: vscode.Range[]) => { view.ranges = ranges; },
  } as unknown as vscode.TextEditor;
  return { model, document, editor, view, positionAt };
}
function setup(t: TestContext, text = '![yes](./yes.png)\n![offscreen](./offscreen.png)', check?: Check) {
  mock.reset();
  const fixture = note(text);
  mock.window.visibleTextEditors = [fixture.editor];
  const clock = new Clock();
  const calls: string[] = [];
  const controller = new ImageTagHighlighter({ schedule: clock.schedule, stat: async uri => {
    calls.push(uri.path);
    return check ? check(uri) : file;
  } });
  t.after(() => controller.dispose());
  const scroll = () => mock.visibleRangesChange.fire({ textEditor: fixture.editor, visibleRanges: fixture.editor.visibleRanges });
  const replace = async (start: number, length: number, text: string) => {
    const range = new mock.Range(fixture.positionAt(start), fixture.positionAt(start + length));
    fixture.model.text = fixture.model.text.slice(0, start) + text + fixture.model.text.slice(start + length);
    fixture.model.version++;
    await mock.documentChange.fire({ document: fixture.document, contentChanges: [
      { range, rangeOffset: start, rangeLength: length, text },
    ] } as unknown as vscode.TextDocumentChangeEvent);
  };
  const edit = (text: string) => replace(0, fixture.model.text.length, text);
  return { ...fixture, controller, clock, calls, scroll, edit, replace };
}

test('initial full-note pass survives viewport setup, deduplicates paths, and stays idle afterward', async t => {
  const s = setup(t, '![one](./yes.png) and ![two](yes.png)\n![off](./offscreen.png)');
  await s.scroll();
  await s.scroll();
  await s.clock.advance(0);
  assert.deepEqual(s.calls.sort(), ['/workspace/offscreen.png', '/workspace/yes.png']);
  assert.equal(s.view.ranges.length, 3);
  assert.deepEqual(s.view.ranges[0], new mock.Range(s.positionAt(0), s.positionAt(17)));
  assert.equal((mock.decorations[0]!.options.color as mock.ThemeColor).id, 'markdownPicture.imageTagForeground');
  assert.equal(s.clock.jobs.size, 0);
  await s.clock.advance(120_000);
  assert.equal(s.calls.length, 2);
});

test('later checks debounce scrolling for 20 seconds and inspect only visible targets in all splits', async t => {
  const s = setup(t);
  await s.clock.advance(0);
  s.calls.length = 0;
  const split = { ...s.editor, visibleRanges: [new mock.Range(s.positionAt(19), s.positionAt(s.model.text.length))] };
  mock.window.visibleTextEditors.push(split as unknown as vscode.TextEditor);
  await mock.visibleEditorsChange.fire(mock.window.visibleTextEditors);
  await s.clock.advance(10_000);
  await s.scroll();
  await s.clock.advance(19_999);
  assert.equal(s.calls.length, 0);
  await s.clock.advance(1);
  assert.deepEqual(s.calls.sort(), ['/workspace/offscreen.png', '/workspace/yes.png']);
  mock.window.visibleTextEditors.pop();
  s.calls.length = 0;
  await s.scroll();
  await s.clock.advance(20_000);
  assert.deepEqual(s.calls, ['/workspace/yes.png']);
  assert.equal(s.model.reads, 1, 'Unchanged syntax is cached');
  assert.equal(s.clock.jobs.size, 0);
});

test('only existing local inline image files are colored; code, references, and URLs are ignored', async t => {
  const text = [
    '![yes](./yes.png) ![encoded](./my%20photo.png)',
    '![missing](./missing.png) ![folder](./folder.png) ![denied](./denied.png)',
    '![web](https://example.com/a.png) ![data](data:image/png;base64,xxx)',
    '![text](./file.txt) ![absolute](/a.png) ![fragment](./yes.png#x)',
    '`![code](./code.png)`', '```md', '![fenced](./fenced.png)', '```',
    '![reference][ref]', '[ref]: ./ref.png', '[link](./link.png)',
  ].join('\n');
  const s = setup(t, text, async uri => {
    if (uri.path.endsWith('/missing.png')) return undefined;
    if (uri.path.endsWith('/folder.png')) return directory;
    if (uri.path.endsWith('/denied.png')) throw new Error('No access');
    return file;
  });
  await s.clock.advance(0);
  assert.deepEqual(s.calls.sort(), ['denied.png', 'folder.png', 'missing.png', 'my photo.png', 'yes.png'].map(name => `/workspace/${name}`));
  assert.equal(s.view.ranges.length, 2);
});

test('size precheck, exact UTF-8 cap, and image density cap prevent metadata checks', async t => {
  for (const [text, reads] of [
    ['a'.repeat(highlightLimits.documentBytes + 1), 0],
    ['あ'.repeat(Math.floor(highlightLimits.documentBytes / 3) + 1), 1],
    ['![a](./a.png) '.repeat(highlightLimits.documentImages + 1), 1],
  ] as const) {
    const s = setup(t, text);
    await s.clock.advance(0);
    assert.equal(s.calls.length, 0);
    assert.equal(s.model.reads, reads);
    assert.equal(s.view.ranges.length, 0);
    s.controller.dispose();
  }
});

test('later scans cap distinct visible targets at 256', async t => {
  const s = setup(t, Array.from({ length: 260 }, (_, i) => `![${i}](./${i}.png)`).join(' '));
  await s.clock.advance(0);
  assert.equal(s.calls.length, 260);
  s.calls.length = 0;
  await s.scroll();
  await s.clock.advance(20_000);
  assert.equal(s.calls.length, highlightLimits.visibleTargets);
});

test('image edits immediately remove stale colors, then refresh syntax and positions after five seconds', async t => {
  const s = setup(t);
  await s.clock.advance(0);
  await s.edit('prefix ![new](./new.png)');
  assert.equal(s.view.ranges.length, 0);
  await s.clock.advance(4_999);
  assert.equal(s.calls.length, 2);
  await s.clock.advance(1);
  assert.equal(s.calls.at(-1), '/workspace/new.png');
  assert.deepEqual(s.view.ranges, [new mock.Range(s.positionAt(7), s.positionAt(s.model.text.length))]);
  assert.equal(s.model.reads, 2);
});

test('one changed link produces one five-second update; scrolling and companion file events do not postpone it', async t => {
  const s = setup(t, '![old](./old.png)');
  await s.clock.advance(0);
  s.calls.length = 0;
  await s.replace(9, 3, 'new');
  await s.clock.advance(2_000);
  await s.scroll();
  await mock.fileRename.fire({ files: [{ oldUri: s.document.uri, newUri: s.document.uri }] });
  assert.equal(s.clock.jobs.size, 1);
  await s.clock.advance(2_999);
  assert.equal(s.calls.length, 0);
  await s.clock.advance(1);
  assert.deepEqual(s.calls, ['/workspace/new.png']);
  assert.equal(s.view.ranges.length, 1);
  assert.equal(s.clock.jobs.size, 0);
  await s.clock.advance(120_000);
  assert.equal(s.calls.length, 1, 'A single edit must not create recurring updates');
});

test('further image-link edits reset a single five-second timer', async t => {
  const s = setup(t, '![old](./old.png)');
  await s.clock.advance(0);
  s.calls.length = 0;
  await s.replace(9, 3, 'one');
  await s.clock.advance(4_000);
  await s.replace(9, 3, 'two');
  await s.clock.advance(4_999);
  assert.equal(s.calls.length, 0);
  assert.equal(s.clock.jobs.size, 1);
  await s.clock.advance(1);
  assert.deepEqual(s.calls, ['/workspace/two.png']);
});

test('newly typed tags use five seconds while edits away from image tags retain twenty seconds', async t => {
  const s = setup(t, 'plain text\n![old](./old.png)');
  await s.clock.advance(0);
  await s.replace(0, 5, 'other');
  await s.clock.advance(5_000);
  assert.equal(s.calls.length, 1);
  assert.equal(s.clock.jobs.size, 1);
  await s.clock.advance(15_000);
  // The visible line contains no images; that update refreshes syntax without file checks.
  assert.equal(s.calls.length, 1);
  await s.replace(10, 0, ' !');
  await s.replace(12, 0, '[new](./new.png)');
  Object.assign(s.editor, { visibleRanges: [new mock.Range(s.positionAt(0), s.positionAt(s.model.text.indexOf('\n')))] });
  await s.scroll();
  await s.clock.advance(4_999);
  assert.equal(s.calls.length, 1);
  await s.clock.advance(1);
  assert.deepEqual(s.calls, ['/workspace/old.png', '/workspace/new.png']);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('metadata concurrency is globally bounded across documents and initial scroll does not restart work', async t => {
  const gate = deferred<void>();
  let active = 0, peak = 0;
  const s = setup(t, Array.from({ length: 10 }, (_, i) => `![${i}](./${i}.png)`).join(' '), async () => {
    peak = Math.max(peak, ++active);
    await gate.promise;
    active--;
    return file;
  });
  const second = note('![second](./second.png)', 'second.md');
  mock.window.visibleTextEditors.push(second.editor);
  await mock.visibleEditorsChange.fire(mock.window.visibleTextEditors);
  const work = s.clock.advance(0);
  await tick();
  assert.equal(s.calls.length, 4);
  await s.scroll();
  assert.equal(s.clock.jobs.size, 0);
  gate.resolve();
  await work;
  assert.equal(peak, 4);
  assert.equal(s.calls.length, 11);
  assert.equal(second.view.ranges.length, 1);
});

test('stale asynchronous results cannot paint an edited or closed document', async t => {
  for (const action of ['edit', 'close'] as const) {
    const gate = deferred<vscode.FileStat>();
    const s = setup(t, '![a](./a.png)', () => gate.promise);
    const work = s.clock.advance(0);
    await tick();
    if (action === 'edit') await s.edit('plain text');
    else { s.model.isClosed = true; await mock.documentClose.fire(s.document); }
    gate.resolve(file);
    await work;
    assert.equal(s.view.ranges.length, 0);
    await s.clock.advance(20_000);
    assert.equal(s.calls.length, 1);
    assert.equal(s.view.ranges.length, 0);
    s.controller.dispose();
  }
});

test('hiding or unfocusing cancels pending work; returning resumes without polling', async t => {
  const s = setup(t);
  mock.window.state.focused = false;
  await mock.windowChange.fire(mock.window.state as vscode.WindowState);
  await s.clock.advance(60_000);
  assert.equal(s.calls.length, 0);
  mock.window.state.focused = true;
  await mock.windowChange.fire(mock.window.state as vscode.WindowState);
  await s.clock.advance(0);
  assert.equal(s.calls.length, 2);
  await s.scroll();
  mock.window.visibleTextEditors = [];
  await mock.visibleEditorsChange.fire([]);
  await s.clock.advance(60_000);
  assert.equal(s.calls.length, 2);
  mock.window.visibleTextEditors = [s.editor];
  await mock.visibleEditorsChange.fire([s.editor]);
  await s.clock.advance(20_000);
  assert.equal(s.calls.length, 3);
});

test('an interrupted opening pass resumes without rechecking completed targets', async t => {
  const gate = deferred<void>();
  const s = setup(t, Array.from({ length: 6 }, (_, i) => `![${i}](./${i}.png)`).join(' '), async uri => {
    if (!uri.path.endsWith('/0.png')) await gate.promise;
    return file;
  });
  const work = s.clock.advance(0);
  await tick();
  mock.window.state.focused = false;
  await mock.windowChange.fire(mock.window.state as vscode.WindowState);
  gate.resolve();
  await work;
  mock.window.state.focused = true;
  await mock.windowChange.fire(mock.window.state as vscode.WindowState);
  await s.clock.advance(0);
  assert.equal(s.calls.filter(name => name.endsWith('/0.png')).length, 1);
  assert.equal(s.view.ranges.length, 6);
});

test('file operation events clear stale presence and schedule delayed visible rechecks', async t => {
  let exists = true;
  const s = setup(t, '![a](./a.png)', async () => exists ? file : undefined);
  await s.clock.advance(0);
  exists = false;
  await mock.fileDelete.fire({ files: [s.document.uri] });
  assert.equal(s.view.ranges.length, 0);
  await s.clock.advance(20_000);
  assert.equal(s.view.ranges.length, 0);
  exists = true;
  await mock.fileCreate.fire({ files: [s.document.uri] });
  await s.clock.advance(20_000);
  assert.equal(s.view.ranges.length, 1);
  exists = false;
  await mock.fileRename.fire({ files: [{ oldUri: s.document.uri, newUri: s.document.uri }] });
  await s.clock.advance(20_000);
  assert.equal(s.view.ranges.length, 0);
});

test('disable and disposal clear decorations, cancel timers, and remove event subscriptions', async t => {
  const s = setup(t);
  await s.clock.advance(0);
  mock.config.highlightImages = false;
  await mock.configChange.fire({ affectsConfiguration: () => true } as unknown as vscode.ConfigurationChangeEvent);
  assert.equal(s.view.ranges.length, 0);
  assert.equal(s.clock.jobs.size, 0);
  mock.config.highlightImages = true;
  await mock.configChange.fire({ affectsConfiguration: () => true } as unknown as vscode.ConfigurationChangeEvent);
  await s.clock.advance(0);
  assert.equal(s.view.ranges.length, 2);
  s.controller.dispose();
  assert.equal(s.view.ranges.length, 0);
  assert.equal(mock.decorations[0]!.disposed, true);
  await s.scroll();
  await mock.documentOpen.fire(s.document);
  assert.equal(s.clock.jobs.size, 0);
});

test('closed, unsaved, non-Markdown, untrusted, and disabled documents do no work', async t => {
  for (const kind of ['closed', 'unsaved', 'language', 'extension', 'untrusted', 'disabled'] as const) {
    const s = setup(t);
    s.controller.dispose();
    if (kind === 'closed') s.model.isClosed = true;
    if (kind === 'unsaved') Object.assign(s.document, { isUntitled: true });
    if (kind === 'language') Object.assign(s.document, { languageId: 'plaintext' });
    if (kind === 'extension') (s.document.uri as unknown as mock.Uri).path = '/workspace/note.txt';
    if (kind === 'untrusted') mock.workspace.isTrusted = false;
    if (kind === 'disabled') mock.config.enabled = false;
    const controller = new ImageTagHighlighter({ schedule: s.clock.schedule, stat: async () => { assert.fail('Must not stat'); } });
    assert.equal(s.clock.jobs.size, 0);
    controller.dispose();
  }
});

test('an invisibly opened note waits until visible before the initial full pass', async t => {
  const s = setup(t);
  await s.clock.advance(0);
  const hidden = note('![hidden](./hidden.png)', 'hidden.md');
  await mock.documentOpen.fire(hidden.document);
  assert.equal(s.clock.jobs.size, 0);
  mock.window.visibleTextEditors = [hidden.editor];
  await mock.visibleEditorsChange.fire([hidden.editor]);
  await s.clock.advance(0);
  assert.equal(s.calls.at(-1), '/workspace/hidden.png');
  assert.equal(hidden.view.ranges.length, 1);
});
