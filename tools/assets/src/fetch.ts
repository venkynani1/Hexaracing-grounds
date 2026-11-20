/** Download every source file into tools/assets/.cache, pinned by sha256 (sources.lock.json). */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCES } from './sources';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE = join(ROOT, '.cache');
const LOCK = join(ROOT, 'sources.lock.json');
const lock: Record<string, string> = existsSync(LOCK) ? JSON.parse(readFileSync(LOCK, 'utf8')) : {};
const update = process.argv.includes('--update-lock');

let changed = false;
for (const src of SOURCES) {
  for (const f of src.files) {
    const out = join(CACHE, src.id, f.name);
    const key = `${src.id}/${f.name}`;
    let buf: Buffer;
    if (existsSync(out)) buf = readFileSync(out);
    else {
      const res = await fetch(f.url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`${f.url} → HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, buf);
      console.log(`fetched ${key} (${(buf.length / 1024).toFixed(0)} KB)`);
    }
    const sha = createHash('sha256').update(buf).digest('hex');
    if (!lock[key] || update) (lock[key] = sha), (changed = true);
    else if (lock[key] !== sha) throw new Error(`sha256 mismatch for ${key}: expected ${lock[key]}, got ${sha} (source changed — review the licence again, then --update-lock)`);
  }
}
if (changed) writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
console.log(`ok: ${Object.keys(lock).length} files verified`);
