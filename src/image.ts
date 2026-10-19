import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { CancellationToken } from 'vscode';

export type JpegQuality = 'high' | 'medium' | 'low';
export interface PreparedImage { contents: Uint8Array; extension: string }
export const jpegQualities = { high: 90, medium: 75, low: 50 } as const;
export const conversionLimits = { inputBytes: 32 * 1024 * 1024, pixels: 20_000_000, timeoutMs: 30_000 } as const;

/** Codecs run off the extension host thread, including on SSH/WSL/container hosts. */
export function prepareImage(
  contents: Uint8Array, extension: string, convert: boolean, quality: JpegQuality, token: CancellationToken,
): Promise<PreparedImage | undefined> {
  if (token.isCancellationRequested) return Promise.resolve(undefined);
  // JPEG is already compressed. Keep it (and formats we cannot decode) byte-for-byte.
  if (!convert || extension !== '.png' || contents.byteLength > conversionLimits.inputBytes) {
    return Promise.resolve({ contents, extension });
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'image-worker.cjs'), {
      workerData: { contents, quality: quality === 'high' ? jpegQualities.high : quality === 'low' ? jpegQualities.low : jpegQualities.medium },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let settled = false;
    let subscription: { dispose(): unknown } | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result?: PreparedImage, error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      subscription?.dispose();
      void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    worker.once('message', (message: PreparedImage | { error: string }) => {
      if ('error' in message) finish(undefined, new Error(message.error));
      else finish(message);
    });
    worker.once('error', error => finish(undefined, error));
    worker.once('exit', code => {
      if (!settled) finish(undefined, new Error(`Image conversion stopped unexpectedly (${code}).`));
    });
    subscription = token.onCancellationRequested(() => finish());
    // Cover cancellation between the initial check and listener registration.
    if (token.isCancellationRequested) finish();
    if (!settled) timer = setTimeout(() => finish(undefined, new Error('Image conversion timed out. Disable markdownPicture.convertToJpeg to paste the original.')), conversionLimits.timeoutMs);
  });
}
