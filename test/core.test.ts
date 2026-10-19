import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { availableName, imageAt, imageExtension, imageLinks, imageMarkdown, localImagePath, markdownPath, normalizeDestination, normalizeDirectory } from '../src/core';

test('finds inline image destinations, including titles, escaped brackets, and nested parentheses', () => {
  const text = 'Before ![a \\[bracket\\]](./img/a(b).png "Title") and ![two](<./my photo.png>)';
  const links = imageLinks(text);
  assert.equal(links.length, 2);
  assert.equal(text.slice(links[0]!.pathStart, links[0]!.pathEnd), './img/a(b).png');
  assert.equal(links[0]!.title, 'Title');
  assert.equal(imageAt(text, text.indexOf('(<'))?.url, './my photo.png');
  assert.equal(imageAt(text, text.lastIndexOf(')'))?.url, './my photo.png');
  assert.equal(text.slice(links[1]!.pathStart, links[1]!.pathEnd), './my photo.png');
  assert.equal(imageAt(text, text.indexOf('a(b)'))?.url, './img/a(b).png');
  assert.equal(imageAt(text, text.indexOf('Before')), undefined);
});

test('does not treat links, code examples, reference syntax, or escaped image syntax as inline images', () => {
  const text = '[link](./link.png) `![code](./code.png)`\n\n```md\n![fence](./fence.png)\n```\n\n    ![indent](./indent.png)\n\n\\![escaped](./escaped.png)\n\n![ref][id]\n\n[id]: ./ref.png\n\n![real](./real.png)';
  assert.deepEqual(imageLinks(text).map(link => link.url), ['./real.png']);
});

test('handles multiple images on the same line, Unicode, CRLF, and nested image links', () => {
  const text = '日本語\r\n[![a](./a.png)](https://example.com) ![b](./b.png)';
  const links = imageLinks(text);
  assert.equal(links.length, 2);
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.url.includes('a.png') ? '![a](./a.png)' : '![b](./b.png)');
});

test('emits rendered images with safe paths and alt text, preserving titles', () => {
  const literal = 'img/日本語 [a] #100% (ok).png';
  const rendered = imageMarkdown(literal, 'A "quoted" title & more');
  assert.ok(rendered.startsWith('!['));
  assert.ok(rendered.includes('%20'));
  const parsed = imageLinks(rendered);
  assert.equal(parsed.length, 1);
  assert.equal(localImagePath(parsed[0]!.url), literal);
  assert.equal(parsed[0]!.title, 'A "quoted" title & more');
  assert.equal(imageMarkdown('img/newName.jpg'), '![newName](./img/newName.jpg)');
  assert.equal(markdownPath('../shared/pic.png'), '../shared/pic.png');
});

test('normalizes relative paths on all platforms and preserves image formats', () => {
  assert.equal(normalizeDestination('.\\img\\newName.png', '.png'), 'img/newName.png');
  assert.equal(normalizeDestination('./img/../photo.jpeg', '.jpg'), 'photo.jpeg');
  assert.equal(normalizeDirectory('./img/screenshots/'), 'img/screenshots');
  assert.equal(normalizeDirectory('.'), '.');
  assert.equal(normalizeDirectory('../'), '..');
  assert.equal(imageExtension('PHOTO.JPEG'), '.jpeg');
  assert.equal(imageExtension('notes.md'), undefined);
  assert.throws(() => normalizeDestination('photo.jpg', '.png'), /does not convert/);
});

test('rejects remote, absolute, malformed, and nonportable destinations', () => {
  for (const value of ['', ' /a.png', '/a.png', 'C:\\a.png', '//host/a.png', 'https://a.png', 'img/', 'img/.', '../', 'CON.png', 'img/NUL/a.png', 'a?.png', 'bad./a.png', 'a\u0000.png']) {
    assert.throws(() => normalizeDestination(value), value);
  }
  for (const value of ['https://host/a.png', 'data:image/png;base64,AA', '/root/a.png', './a.png#fragment', './a.png?q=x', './bad%zz.png', '%2Fa.png']) {
    assert.throws(() => localImagePath(value), value);
  }
  assert.equal(localImagePath('./a%23b%25.png'), 'a#b%.png');
});

test('avoids both file and directory name collisions without overwriting', async () => {
  const used = new Set(['img/picture.png', 'img/picture-1.png']);
  assert.equal(await availableName('img', '.png', async name => used.has(name), 'picture'), 'img/picture-2.png');
});
