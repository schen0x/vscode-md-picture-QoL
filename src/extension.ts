import * as vscode from 'vscode';
import { PicturePasteProvider, picturePasteKind } from './paste';
import { PictureRenameController } from './rename';
import { ImageTagHighlighter } from './highlight';

export function activate(context: vscode.ExtensionContext): void {
  const rename = new PictureRenameController();
  context.subscriptions.push(
    rename,
    new ImageTagHighlighter(),
    vscode.commands.registerCommand('markdownPicture.renameImage', () => rename.rename()),
    vscode.languages.registerDocumentPasteEditProvider(
      [
        { language: 'markdown', scheme: 'file', pattern: '**/*.[mM][dD]' },
        { language: 'markdown', scheme: 'vscode-remote', pattern: '**/*.[mM][dD]' },
      ],
      new PicturePasteProvider(),
      { pasteMimeTypes: ['image/*', 'files'], providedPasteEditKinds: [picturePasteKind] },
    ),
  );
}
