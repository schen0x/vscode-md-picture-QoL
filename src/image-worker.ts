import { parentPort, workerData } from 'node:worker_threads';
import { PNG } from 'pngjs';
import { encode } from 'jpeg-js';
import { conversionLimits } from './image';

function convert(contents: Uint8Array, quality: number) {
  const input = Buffer.from(contents);
  if (input.length < 33 || !input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    || input.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG clipboard image.');
  const width = input.readUInt32BE(16);
  const height = input.readUInt32BE(20);
  if (!width || !height) throw new Error('Invalid PNG dimensions.');
  // Read dimensions before the decoder allocates pixel buffers.
  if (width * height > conversionLimits.pixels || width > 65535 || height > 65535) {
    return { contents, extension: '.png' };
  }
  for (let offset = 8; offset < input.length;) {
    if (offset + 12 > input.length) throw new Error('Truncated PNG clipboard image.');
    const length = input.readUInt32BE(offset);
    const type = input.toString('ascii', offset + 4, offset + 8);
    if (offset + length + 12 > input.length) throw new Error('Truncated PNG clipboard image.');
    // Do not discard animation by decoding only its first frame.
    if (type === 'acTL') return { contents, extension: '.png' };
    offset += length + 12;
  }
  const image = PNG.sync.read(input);
  PNG.adjustGamma(image);
  // JPEG has no alpha channel. Composite against white before encoding.
  for (let i = 0; i < image.data.length; i += 4) {
    const alpha = image.data[i + 3]! / 255;
    for (let channel = 0; channel < 3; channel++) {
      image.data[i + channel] = Math.round(image.data[i + channel]! * alpha + 255 * (1 - alpha));
    }
    image.data[i + 3] = 255;
  }
  return { contents: encode(image, quality).data, extension: '.jpg' };
}

try {
  parentPort!.postMessage(convert(workerData.contents, workerData.quality));
} catch (error) {
  parentPort!.postMessage({ error: `Could not convert PNG to JPEG: ${error instanceof Error ? error.message : String(error)} Disable markdownPicture.convertToJpeg to paste the original.` });
}
