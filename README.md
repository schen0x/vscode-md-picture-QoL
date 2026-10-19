# Markdown Picture QoL

Quality of Life plugin for Markdown (`*.md`) (VSCode extension)

- Paste an image to insert into a markdown file
  - auto save the image into a folder inside the workspace
  - auto unique name

- Press `F2` key on the markdown image link (the `(./*.jpg)` part) to rename and move

- Auto highlight an markdown image link if the image exists, hover over the link to peek the image

- Optionally (enabled by default), auto convert PNG to JPG to save space

- Existing destination files and folders are never overwritten

- VSCode's Undo can revert a rename or paste behavior including its implied file operation (exception: a newly created folder if exists, will remain)

- Dependency: desktop VS Code **1.100 or newer** on macOS, Windows, and Linux
  - The extension uses VS Code's clipboard transfer and filesystem APIs, no additional external tools are required

## Use

1. Open a `*.md` file, in Markdown language mode, in a trusted workspace
2. Copy an image, paste it (i.e., usually `Cmd+V` or `Ctrl+V`)


   The extension will save the image, and insert a link into the markdown. Hover over the link to peek the image

   ```md
   ![image-xxxxxxxx-UUID-xxxx-xxxx-xxxxxxxxxxxx](./image-xxxxxxxx-UUID-xxxx-xxxx-xxxxxxxxxxxx.jpg)
   ```

3. PNG are auto converted to medium quality JPG by default to save space
   Existing JPEGs and other formats keep their original bytes; see [JPEG conversion](#jpeg-conversion).


4. Hover cursor on the `(./*.jpg)` part of the markdown image link, press `F2` to rename and move the image. Only accept relative path that land inside the workspace. Does not allow symbolic linked folder as the destination. Use `Esc` or click elsewhere to cancel the rename. Switch to another application keep the renaming window


## Relevant VSCode document


- [pasting image data and files into Markdown](https://code.visualstudio.com/docs/languages/markdown#_inserting-images-and-links-to-files)
  - `markdown.copyFiles.destination` controls placement

## JPEG conversion

- auto convert PNG to JPG by default to save space
  - quality options
    - `high`   - 90
    - `medium` - 75 (default)
    - `low`    - 50
  - picture dimensions - unchanged
  - transparency - composited onto **white**, gamma applied
  - metadata - not retained

- config
  - disable the conversion to paste original as-is

```json
{
  "markdownPicture.convertToJpeg": false
}
```

- PNG > 32MB or 20 million pixels are not converted
- PNG dimension above JPG's 65535-pixel limit on either axis are preserved
- JPG source or other format are not converted

- Implementation detail
  - package used
    - [pngjs](https://github.com/pngjs/pngjs)
    - [jpeg-js](https://github.com/jpeg-js/jpeg-js)
  - runs on a cancellable worker on the extension host
  - conversation prepares bytes in-memory
  - files and folders are created on VSCode "paste"


## Image tag color

- extension check whether an markdown picture is backed by a real picture, if true, highlight the link.
- The highlight color is customizable

```json
"workbench.colorCustomizations": {
  "markdownPicture.imageTagForeground": "#80AA98"
}
```

- highlight can be disabled

```json
"workbench.colorCustomizations": {
  "markdownPicture.highlightImages": false
}
```

- Implementation detail
  - The whole markdown file is checked on open
  - No periodic polling or filesystem watcher
  - Only visible links are checked afterwards
    - triggered 5s after an update, further edit reset the timer
    - scrolling does not pospone the update
    - other edits and scrolling trigger a check about 20s after an activity stops
    - returning to the editor or a VSCode file create/delete/rename triggers a check
  - Boundaries
    - only works if the size of the markdown file <1MB
    - only works if the total count of markdown image links <2048
    - later scan checks at most 256 distinct visible image targets, at most 4 metadata requests at a time, duplicate destinations share a check


## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `markdownPicture.enabled` | `true` | Enable the extension |
| `markdownPicture.pasteDirectory` | `"."` | Default images location on paste, relative location only. e.g. `"./imgs"` |
| `markdownPicture.createDirectories` | `true` | Allow paste and rename to create missing destination folders. If false, the folder must already exist |
| `markdownPicture.convertToJpeg` | `true` | Convert PNG to JPG on paste |
| `markdownPicture.jpegQuality` | `"medium"` | Converted JPEG quality: `"high"` (90), `"medium"` (75), or `"low"` (50) |
| `markdownPicture.highlightImages` | `true` | Color of inline tags that actually has an image files |

Change the shortcut in **Keyboard Shortcuts**, searching for **Markdown Picture: Rename / Move Image**. Or in `keybindings.json`:

```json
[
  {
    "key": "f2",
    "command": "-markdownPicture.renameImage"
  },
  {
    "key": "ctrl+alt+r",
    "command": "markdownPicture.renameImage",
    "when": "editorTextFocus && !editorReadonly && editorLangId == markdown && resourceExtname =~ /\\.[mM][dD]$/"
  }
]
```

The extension add a default Markdown paste preference. When this extension is not the selected paste provider, use **Paste As… -> Paste Image into Note**, or in the setting:

```json
{
  "[markdown]": {
    "editor.pasteAs.preferences": ["markdown.link.image.pictureQol"]
  }
}
```

Keep `editor.pasteAs.enabled` enabled. Regular text paste is unchanged. The OS/application must expose image bytes or image files to VS Code's paste API; a copied web URL alone is ordinary text.


## Misc

- cross-platform: Path Names are checked for cross-platform in Windows, OSX, and Linux
- Rename preserves image format: `.png` stays `.png`; `.jpg` and `.jpeg` are interchangeable 
- Supported clipboard MIME types include PNG, JPEG, GIF, WebP, BMP, SVG, AVIF, TIFF, ICO, HEIC, and HEIF. Whether the preview displays a format depends on VS Code's renderer

- The extension not work on unsaved notes, non-`.md` files, untrusted workspaces, virtual filesystems, and browser-only VS Code. Remote SSH/WSL/dev-container documents use VS Code's remote filesystem APIs.

## Build and deploy

- build requirement: Node.js >=22 LTS

```sh
npm ci
npm test
npm run package
```

- build and deploy

```sh
./rebuild.sh --deps
./rebuild.sh && ./deploy.sh
```

```powershell
.\rebuild.ps1 -Deps
if ($LASTEXITCODE -eq 0) { .\deploy.ps1 }
```

- deploy to a specific destination

```sh
./deploy.sh --extensions-dir "$PWD/.vscode-local/extensions" --user-data-dir "$PWD/.vscode-local/user-data"
```

```powershell
./deploy.ps1 -ExtensionsDir "$PWD/.vscode-local/extensions" -UserDataDir "$PWD/.vscode-local/user-data"
```

### Test

```sh
npm test                  # Typecheck, build, feature tests, and native workflow checks
npm run test:integration  # Download isolated VS Code; exercise real file/edit/Undo APIs
npm run package           # Produce the installable VSIX
```
