import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { envelopeSchema, type Envelope } from '@quiet/shared';

// This directory is private storage, never a static HTTP root.
export function imageFiles(directory: string) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  function path(name: string) {
    if (!/^[0-9a-f-]{36}\.enc$/.test(name)) throw new Error('Invalid encrypted file reference.');
    return resolve(root, name);
  }
  function remove(name: string) {
    try { unlinkSync(path(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return {
    write(envelope: Envelope) {
      const name = `${randomUUID()}.enc`;
      try {
        writeFileSync(path(name), JSON.stringify(envelope), { flag: 'wx', mode: 0o600, flush: true });
        // Persist the directory entry before SQLite commits its reference.
        const fd = openSync(root, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        return name;
      } catch (error) { remove(name); throw error; }
    },
    read(name: string) { return envelopeSchema.parse(JSON.parse(readFileSync(path(name), 'utf8'))); },
    remove,
    sweep(referenced: Set<string>) {
      for (const name of readdirSync(root)) if (/^[0-9a-f-]{36}\.enc$/.test(name) && !referenced.has(name)) remove(name);
    },
  };
}
