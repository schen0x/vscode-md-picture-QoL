import * as vscode from 'vscode';
import { imageAt, localImagePath, normalizeDestination, imageExtension } from './core';
import { buildRenameEdit, displayPath, isMarkdownNote, settings } from './files';

export class PictureRenameController implements vscode.Disposable {
  private cancelCurrent?: () => void;

  dispose(): void { this.cancelCurrent?.(); }

  async rename(): Promise<void> {
    this.cancelCurrent?.();
    const editor = vscode.window.activeTextEditor;
    if (!editor || !vscode.workspace.isTrusted || !isMarkdownNote(editor.document) || !settings(editor.document).enabled) {
      await vscode.commands.executeCommand('editor.action.rename');
      return;
    }
    const document = editor.document;
    const link = imageAt(document.getText(), document.offsetAt(editor.selection.active));
    if (!link) {
      await vscode.commands.executeCommand('editor.action.rename');
      return;
    }
    let original: string;
    try { original = localImagePath(link.url); }
    catch (error) {
      void vscode.window.showErrorMessage(`Markdown Picture: ${message(error)}`);
      return;
    }
    const version = document.version;
    const input = vscode.window.createInputBox();
    input.title = 'Rename / Move Markdown Image';
    input.prompt = 'Relative to this note. Enter moves the image; Esc or clicking in the editor cancels.';
    input.placeholder = './img/newName.png';
    input.value = displayPath(original);
    input.ignoreFocusOut = true; // Deliberately keep the draft when switching to another application.
    const basename = input.value.lastIndexOf('/') + 1;
    const extension = input.value.lastIndexOf('.');
    input.valueSelection = [basename, extension > basename ? extension : input.value.length];

    await new Promise<void>(resolve => {
      const disposables: vscode.Disposable[] = [];
      let closed = false;
      let accepting = false;
      const close = () => {
        if (closed) return;
        closed = true;
        this.cancelCurrent = undefined;
        for (const disposable of disposables) disposable.dispose();
        input.dispose();
        resolve();
      };
      this.cancelCurrent = close;
      disposables.push(
        input.onDidHide(close),
        input.onDidChangeValue(value => {
          try { normalizeDestination(value, imageExtension(original)); input.validationMessage = undefined; }
          catch (error) { input.validationMessage = message(error); }
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
          if (!accepting && vscode.window.state.focused && event.textEditor === editor) close();
        }),
        vscode.window.onDidChangeActiveTextEditor(active => {
          if (!accepting && vscode.window.state.focused && active !== editor) close();
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
          if (!accepting && event.document === document && event.contentChanges.length) close();
        }),
        vscode.workspace.onDidCloseTextDocument(closing => { if (closing === document) close(); }),
        input.onDidAccept(async () => {
          if (accepting || closed) return;
          accepting = true;
          input.busy = true;
          input.enabled = false;
          try {
            if (document.version !== version) throw new Error('The note changed. Cancel and try again.');
            const edit = await buildRenameEdit(document, link, input.value);
            if (closed) return;
            if (document.version !== version) throw new Error('The note changed. Cancel and try again.');
            const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: true });
            if (!applied) throw new Error('VS Code could not apply the move. The destination may have changed or may be read-only.');
            close();
            await vscode.window.showTextDocument(document, { viewColumn: editor.viewColumn, preserveFocus: false });
          } catch (error) {
            if (!closed) input.validationMessage = message(error);
          } finally {
            accepting = false;
            if (!closed) { input.busy = false; input.enabled = true; }
          }
        }),
      );
      input.show();
    });
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
