import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';

/** End of one quoted record followed by the start of the next one. */
const RECORD_BOUNDARIES = [Buffer.from('"\n"'), Buffer.from('"\r\n"')];

/**
 * Returns the offset right after the last line break that separates two CSV
 * records, or -1 when there is none. Line breaks inside quoted fields are not
 * boundaries, because every record of the Receita files starts and ends with a quote.
 */
export function lastRecordBoundary(data: Buffer): number {
  let best = -1;
  for (const boundary of RECORD_BOUNDARIES) {
    const index = data.lastIndexOf(boundary);
    if (index >= 0) {
      best = Math.max(best, index + boundary.length - 1);
    }
  }
  return best;
}

/** Control characters that are never meaningful in the Receita files (keeps \t, \n and \r). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Converts ISO-8859-1 bytes to UTF-8, dropping stray control characters.
 * Decoding latin-1 never fails, unlike strict CSV readers that reject a whole
 * file because of one garbage byte.
 */
export function latin1ToUtf8(data: Buffer): Buffer {
  return Buffer.from(data.toString('latin1').replace(CONTROL_CHARACTERS, ''), 'utf8');
}

/**
 * Streams every file of a ZIP archive and hands it over in temporary chunk
 * files of roughly chunkBytes, always cut between records. Each chunk is
 * deleted after onChunk resolves, so disk usage stays bounded no matter how
 * large the archive is.
 */
export async function forEachChunk(
  zipPath: string,
  workDir: string,
  chunkBytes: number,
  onChunk: (path: string) => Promise<void>,
  transform: (data: Buffer) => Buffer = (data) => data,
): Promise<void> {
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true });
  let chunkIndex = 0;

  const flush = async (data: Buffer): Promise<void> => {
    if (data.length === 0) {
      return;
    }
    const path = join(workDir, `chunk-${chunkIndex++}.csv`);
    await writeFile(path, transform(data));
    try {
      await onChunk(path);
    } finally {
      await rm(path, { force: true });
    }
  };

  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      if (entry.fileName.endsWith('/')) {
        continue;
      }
      const stream: Readable = await zip.openReadStreamPromise(entry);
      let pending: Buffer[] = [];
      let size = 0;

      for await (const piece of stream as AsyncIterable<Buffer>) {
        pending.push(piece);
        size += piece.length;
        if (size < chunkBytes) {
          continue;
        }
        const data = Buffer.concat(pending);
        const cut = lastRecordBoundary(data);
        if (cut < 0) {
          pending = [data];
          continue;
        }
        await flush(data.subarray(0, cut));
        const rest = data.subarray(cut);
        pending = [rest];
        size = rest.length;
      }
      await flush(Buffer.concat(pending));
    }
  } finally {
    zip.close();
  }
}

function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    zip.on('entry', onEntry);
    zip.on('end', onEnd);
    zip.on('error', onError);
    zip.readEntry();
  });
}
