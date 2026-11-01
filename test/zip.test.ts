import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { forEachChunk, lastRecordBoundary } from '../src/data/zip.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'radar-zip-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('lastRecordBoundary', () => {
  it('finds the break between two quoted records', () => {
    const data = Buffer.from('"1";"a"\n"2";"b"\n"3";"c');
    expect(data.subarray(0, lastRecordBoundary(data)).toString()).toBe('"1";"a"\n"2";"b"\n');
  });

  it('ignores line breaks inside quoted fields', () => {
    expect(lastRecordBoundary(Buffer.from('"1";"rua\nnova"'))).toBe(-1);
  });

  it('supports CRLF line endings', () => {
    const data = Buffer.from('"1"\r\n"2"');
    expect(data.subarray(0, lastRecordBoundary(data)).toString()).toBe('"1"\r\n');
  });
});

describe('forEachChunk', () => {
  it('splits archives into whole records and cleans up', async () => {
    const records = Array.from({ length: 200 }, (_, i) => `"${i}";"linha\ncom quebra ${i}"`);
    const zipPath = join(dir, 'data.zip');
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(`${records.join('\n')}\n`), 'DATA.CSV');
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(zipPath));

    const work = await mkdtemp(join(dir, 'work-'));
    const chunks: string[] = [];
    await forEachChunk(zipPath, work, 256, async (path) => {
      chunks.push(await readFile(path, 'utf8'));
    });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.startsWith('"')).toBe(true);
      expect(chunk.endsWith('"\n')).toBe(true);
    }
    expect(chunks.join('')).toBe(`${records.join('\n')}\n`);
    expect(await readdir(work)).toEqual([]);
  });
});
