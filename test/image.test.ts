import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { decode } from 'jpeg-js';
import { prepareImage, conversionLimits } from '../src/image';
import { CancellationTokenSource } from './uiMock';
import { samplePng } from './imageFixture';

test('quality presets produce decodable JPEGs with matching dimensions and decreasing sizes', async () => {
  const png = samplePng();
  const sizes: number[] = [];
  for (const quality of ['high', 'medium', 'low'] as const) {
    const result = (await prepareImage(png, '.png', true, quality, new CancellationTokenSource().token))!;
    assert.equal(result.extension, '.jpg');
    assert.deepEqual([...result.contents.subarray(0, 2)], [0xff, 0xd8]);
    const image = decode(result.contents);
    assert.equal(image.width, 128);
    assert.equal(image.height, 96);
    sizes.push(result.contents.length);
  }
  assert.ok(sizes[0]! > sizes[1]! && sizes[1]! > sizes[2]!);
  assert.ok(sizes[1]! < png.length, 'Medium JPEG should reduce this detailed fixture');
});

test('PNG transparency composites onto white, including partially transparent pixels', async () => {
  const image = new PNG({ width: 16, height: 8 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data.set([0, 0, 0, i % 64 < 32 ? 0 : 128], i);
  }
  const result = (await prepareImage(PNG.sync.write(image), '.png', true, 'high', new CancellationTokenSource().token))!;
  const decoded = decode(result.contents);
  assert.ok(decoded.data[0]! >= 250, 'Transparent black must become white');
  assert.ok(Math.abs(decoded.data[8 * 4]! - 127) <= 4, 'Half-transparent black must become gray');
});

test('disabled conversion and other formats preserve exact bytes', async () => {
  const bytes = samplePng();
  const token = new CancellationTokenSource().token;
  assert.deepEqual(await prepareImage(bytes, '.png', false, 'medium', token), { contents: bytes, extension: '.png' });
  for (const extension of ['.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.avif', '.heic']) {
    const result = await prepareImage(bytes, extension, true, 'medium', token);
    assert.equal(result?.contents, bytes);
    assert.equal(result.extension, extension);
  }
});

test('animated PNG control chunks and oversized images retain their original format', async () => {
  const token = new CancellationTokenSource().token;
  const png = samplePng();
  // The control chunk is sufficient to recognize animation without decoding frames.
  const control = Buffer.from('000000086163544c0000000200000000f38d9370', 'hex');
  const animated = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
  const largeDimensions = Buffer.from(png);
  largeDimensions.writeUInt32BE(conversionLimits.pixels + 1, 16);
  for (const bytes of [animated, largeDimensions, new Uint8Array(conversionLimits.inputBytes + 1)]) {
    const result = (await prepareImage(bytes, '.png', true, 'medium', token))!;
    assert.equal(result.extension, '.png');
    assert.deepEqual(result.contents, new Uint8Array(bytes));
  }
});

test('bad PNG data rejects without hanging or returning mislabeled bytes', async () => {
  await assert.rejects(prepareImage(Buffer.from('bad'), '.png', true, 'medium', new CancellationTokenSource().token), /Invalid PNG/);
  const corrupt = samplePng();
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
  await assert.rejects(prepareImage(corrupt, '.png', true, 'medium', new CancellationTokenSource().token), /crc/i);
});

test('cancellation before and during conversion returns no prepared image', async () => {
  const source = new CancellationTokenSource();
  await source.cancel();
  assert.equal(await prepareImage(samplePng(), '.png', true, 'medium', source.token), undefined);
  const active = new CancellationTokenSource();
  const pending = prepareImage(samplePng(1024, 1024), '.png', true, 'medium', active.token);
  await active.cancel();
  assert.equal(await pending, undefined);
});
