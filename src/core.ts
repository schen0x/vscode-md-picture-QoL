import { posix as path } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Root, RootContent } from 'mdast';

export interface ImageLink {
  start: number;
  end: number;
  pathStart: number;
  pathEnd: number;
  url: string;
  title?: string | null;
}

/** AST positions let us ignore examples in code, ordinary links, and reference syntax. */
export function imageLinks(markdown: string): ImageLink[] {
  const result: ImageLink[] = [];
  // Keep traversal separate from destination scanning so nested image links work too.
  const tree = fromMarkdown(markdown);
  function walk(node: Root | RootContent): void {
    if (node.type === 'image') {
      const start = node.position?.start.offset as number | undefined;
      const end = node.position?.end.offset as number | undefined;
      if (start !== undefined && end !== undefined) {
        const range = destinationRange(markdown, start, end);
        if (range) result.push({ start, end, ...range, url: node.url, title: node.title });
      }
    }
    if ('children' in node) for (const child of node.children) walk(child);
  }
  walk(tree);
  return result;
}

function destinationRange(text: string, start: number, end: number): { pathStart: number; pathEnd: number } | undefined {
  let index = start + 2;
  let brackets = 1;
  while (index < end) {
    const char = text[index++];
    if (char === '\\') { index++; continue; }
    if (char === '[') brackets++;
    if (char === ']' && --brackets === 0) break;
  }
  if (text[index++] !== '(') return;
  while (/\s/.test(text[index] ?? '') && index < end) index++;
  if (text[index] === '<') {
    const pathStart = ++index;
    while (index < end) {
      if (text[index] === '\\') { index += 2; continue; }
      if (text[index] === '>') return { pathStart, pathEnd: index };
      index++;
    }
    return;
  }
  const pathStart = index;
  let parentheses = 0;
  while (index < end) {
    const char = text[index];
    if (char === '\\') { index += 2; continue; }
    if (char === '(') parentheses++;
    if (char === ')') {
      if (parentheses === 0) break;
      parentheses--;
    }
    if (/\s/.test(char ?? '')) break;
    index++;
  }
  return { pathStart, pathEnd: index };
}

export function imageAt(markdown: string, offset: number): ImageLink | undefined {
  return imageLinks(markdown).find(link => {
    const angle = markdown[link.pathStart - 1] === '<';
    return offset >= link.pathStart - (angle ? 2 : 1) && offset <= link.pathEnd + (angle ? 1 : 0);
  });
}

export const mimeExtensions: Readonly<Record<string, string>> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'image/svg+xml': '.svg',
  'image/avif': '.avif', 'image/tiff': '.tiff', 'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico', 'image/heic': '.heic', 'image/heif': '.heif',
};
const imageExtensions = new Set([...Object.values(mimeExtensions), '.jpeg', '.tif']);
export function imageExtension(name: string): string | undefined {
  const extension = path.extname(name).toLowerCase();
  return imageExtensions.has(extension) ? extension : undefined;
}

/** Existing Markdown URLs are encoded. User-entered paths, in contrast, are literal. */
export function localImagePath(url: string): string {
  if (!url || /^(?:[a-z][a-z\d+.-]*:|[/\\])/i.test(url) || /[?#]/.test(url)) {
    throw new Error('Choose an image with a relative local path, without a query or fragment.');
  }
  let decoded: string;
  try { decoded = decodeURIComponent(url); }
  catch { throw new Error('The image link has invalid percent encoding.'); }
  return normalizeDestination(decoded);
}

export function normalizeDirectory(input: string): string {
  const raw = input.replaceAll('\\', '/');
  if (raw === '.' || raw === './') return '.';
  if (raw === '..' || raw === '../') return '..';
  return normalizeDestination(raw.replace(/\/+$/, ''));
}

export function normalizeDestination(input: string, sourceExtension?: string): string {
  if (!input || input !== input.trim()) throw new Error('Enter a relative file path without leading or trailing spaces.');
  const raw = input.replaceAll('\\', '/');
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(raw)) throw new Error('Use a path relative to the Markdown file, such as ./img/photo.png.');
  if (raw.endsWith('/')) throw new Error('Include a file name after the folder.');
  for (const segment of raw.split('/')) {
    if (segment === '.' || segment === '..' || segment === '') continue;
    if (/[<>:"|?*\u0000-\u001f\u007f]/.test(segment) || /[. ]$/.test(segment)) {
      throw new Error('This path contains characters or a trailing dot/space that are not portable across operating systems.');
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
      throw new Error('This file or folder name is reserved on Windows.');
    }
  }
  const normalized = path.normalize(raw);
  if (normalized === '.' || normalized === '..' || raw.endsWith('/.') || raw.endsWith('/..')) {
    throw new Error('Include a file name after the folder.');
  }
  if (sourceExtension) {
    const extension = imageExtension(normalized);
    const family = (ext: string) => ext.replace(/^\.jpeg$/, '.jpg').replace(/^\.tif$/, '.tiff');
    if (!extension || family(extension) !== family(sourceExtension.toLowerCase())) {
      throw new Error(`Keep the ${sourceExtension} image format. Rename moves the file; it does not convert image formats.`);
    }
  }
  return normalized;
}

export function markdownPath(relative: string): string {
  const normalized = path.normalize(relative);
  const prefixed = normalized.startsWith('../') ? normalized : `./${normalized}`;
  return prefixed.split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

export function imageMarkdown(relative: string, title?: string | null): string {
  const name = path.basename(relative, path.extname(relative));
  const alt = name.replace(/[\\`*_{}\[\]<>&!]/g, char => char === '&' ? '&amp;' : `\\${char}`);
  const suffix = title == null ? '' : ` "${title.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('\\', '\\\\')}"`;
  return `![${alt}](${markdownPath(relative)}${suffix})`;
}

export async function availableName(
  directory: string, extension: string, exists: (relative: string) => Promise<boolean>,
  base = `image-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`,
): Promise<string> {
  for (let index = 0; ; index++) {
    const relative = path.join(directory, `${base}${index ? `-${index}` : ''}${extension}`);
    if (!await exists(relative)) return relative;
  }
}
