import { PNG } from 'pngjs';

/** Deterministic photo-like RGB detail gives all three quality presets useful work. */
export function samplePng(width = 128, height = 96): Buffer {
  const image = new PNG({ width, height });
  let seed = 42;
  for (let i = 0; i < image.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      image.data[i + channel] = seed >>> 24;
    }
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}
