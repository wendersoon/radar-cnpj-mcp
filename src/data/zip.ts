import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

/** Extracts every file of a ZIP archive into destDir and returns their paths. */
export async function extractZip(zipPath: string, destDir: string): Promise<string[]> {
  const zip = await yauzl.openPromise(zipPath, { lazyEntries: true });
  const extracted: string[] = [];

  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject);
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          zip.readEntry();
          return;
        }
        // Flatten names so an archive can never write outside destDir.
        const name = entry.fileName.replace(/[\\/]/g, '_');
        const target = join(destDir, `${extracted.length}-${name}`);
        zip
          .openReadStreamPromise(entry)
          .then((stream) => pipeline(stream, createWriteStream(target)))
          .then(() => {
            extracted.push(target);
            zip.readEntry();
          })
          .catch(reject);
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }

  return extracted;
}
