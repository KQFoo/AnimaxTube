import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { createGzip } from 'node:zlib';
import { closeDatabase, getDbPath, openDatabase } from './index.ts';

export interface CompactResult {
  dbPath: string;
  beforeBytes: number;
  afterBytes: number;
  walBytesBefore: number;
  walBytesAfter: number;
  gzipPath?: string;
  gzipBytes?: number;
}

function fileSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Flush the SQLite WAL into the main database file and reclaim free pages
 * so `animaxtube.db` can be backed up or uploaded as a single compact file.
 */
export async function compactDatabase(
  targetPath = getDbPath(),
  opts: { gzip?: boolean } = {}
): Promise<CompactResult> {
  closeDatabase();
  const resolved = path.resolve(targetPath);
  const walPath = `${resolved}-wal`;
  const beforeBytes = fileSizeOrZero(resolved);
  const walBytesBefore = fileSizeOrZero(walPath);

  const db = openDatabase(resolved);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    db.exec('VACUUM;');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    closeDatabase();
  }

  let gzipPath: string | undefined;
  let gzipBytes: number | undefined;
  if (opts.gzip) {
    gzipPath = `${resolved}.gz`;
    await pipeline(fs.createReadStream(resolved), createGzip({ level: 6 }), fs.createWriteStream(gzipPath));
    gzipBytes = fileSizeOrZero(gzipPath);
  }

  return {
    dbPath: resolved,
    beforeBytes,
    afterBytes: fileSizeOrZero(resolved),
    walBytesBefore,
    walBytesAfter: fileSizeOrZero(walPath),
    gzipPath,
    gzipBytes,
  };
}

const isDirect =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  const gzip = process.argv.includes('--gzip');
  const result = await compactDatabase(getDbPath(), { gzip });
  const toMb = (n: number) => (n / (1024 * 1024)).toFixed(2);
  const gzNote = result.gzipPath && result.gzipBytes ? `, gzip ${toMb(result.gzipBytes)} MB -> ${result.gzipPath}` : '';
  console.log(
    `Compacted ${result.dbPath}: DB ${toMb(result.beforeBytes)} MB -> ${toMb(result.afterBytes)} MB, WAL ${toMb(result.walBytesBefore)} MB -> ${toMb(result.walBytesAfter)} MB${gzNote}`
  );
}
