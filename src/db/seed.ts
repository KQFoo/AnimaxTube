import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');

function isValidSqliteFile(filePath: string): boolean {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 100) return false;
    const header = Buffer.alloc(16);
    fd = fs.openSync(filePath, 'r');
    const read = fs.readSync(fd, header, 0, 16, 0);
    return read === 16 && header.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * On fresh volume boot (when DB_PATH does not exist yet), optionally stream a
 * compacted `.db` or `.db.gz` seed file from `SEED_DB_URL` (https:// only).
 */
export async function ensureSeedDatabase(targetPath: string, seedUrl = process.env.SEED_DB_URL): Promise<boolean> {
  if (!seedUrl || targetPath === ':memory:' || fs.existsSync(targetPath)) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(seedUrl.trim());
  } catch {
    throw new Error('Invalid SEED_DB_URL format');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('SEED_DB_URL must use https:// or http://');
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.seed.tmp`;

  console.log(`Downloading initial SQLite seed from ${parsed.origin}${parsed.pathname}...`);
  try {
    const res = await fetch(parsed.href, { redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} downloading seed database`);
    }

    const isGzip =
      parsed.pathname.toLowerCase().endsWith('.gz') ||
      res.headers.get('content-type')?.includes('gzip') ||
      false;

    const webStream = res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>;
    const source = Readable.fromWeb(webStream);
    const dest = fs.createWriteStream(tmpPath);

    if (isGzip) {
      await pipeline(source, createGunzip(), dest);
    } else {
      await pipeline(source, dest);
    }

    if (!isValidSqliteFile(tmpPath)) {
      throw new Error('Downloaded SEED_DB_URL payload is not a valid SQLite 3 database');
    }

    fs.renameSync(tmpPath, targetPath);
    const sizeMb = (fs.statSync(targetPath).size / (1024 * 1024)).toFixed(1);
    console.log(`Seeded database ready at ${targetPath} (${sizeMb} MB).`);
    return true;
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}
