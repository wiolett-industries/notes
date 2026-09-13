import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { envelopeSchema, publicSnapshotSchema, type Envelope, type PublicSnapshot } from '@quiet/shared';

// This directory is private storage, never a static HTTP root.
export function imageFiles(directory: string) {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  function path(name: string) {
    if (!/^[0-9a-f-]{36}\.enc$/.test(name)) throw new Error('Invalid encrypted file reference.');
    return resolve(root, name);
  }
  const readers = new Map<string, number>();
  const retired = new Set<string>();
  function remove(name: string) {
    if (readers.has(name)) { retired.add(name); return; }
    try { unlinkSync(path(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const snapshotPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.public\.json$/;
  function snapshotPath(name: string) {
    if (!snapshotPattern.test(name)) throw new Error('Invalid public snapshot reference.');
    return resolve(root, name);
  }
  function removeSnapshot(name: string) {
    try { unlinkSync(snapshotPath(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return {
    // Stage before BEGIN IMMEDIATE. A returned reference is durable, but is not
    // owned by the database until the caller commits it. Cleanup is the caller's
    // responsibility on conflict, quota rejection, cancellation or rollback.
    async writeAsync(input: Envelope): Promise<string> {
      const envelope = envelopeSchema.parse(input);
      const name = `${randomUUID()}.enc`;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(path(name), 'wx', 0o600);
        // Envelopes contain only canonical base64url. Write bounded strings to
        // avoid allocating/stringifying another image-sized JSON payload.
        await file.writeFile(`{"version":1,"iv":"${envelope.iv}","ciphertext":"`);
        for (let offset = 0; offset < envelope.ciphertext.length; offset += 64 * 1024) await file.writeFile(envelope.ciphertext.slice(offset, offset + 64 * 1024));
        await file.writeFile('"}');
        await file.sync(); await file.close(); file = undefined;
        const directory = await open(root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        return name;
      } catch (error) {
        if (file) await file.close().catch(() => {});
        await unlink(path(name)).catch(() => {});
        throw error;
      }
    },
    // Files are immutable. Keep captured references alive across asynchronous reads
    // while a concurrent committed patch in this process retires the previous version.
    retain(names: string[]) {
      const unique = [...new Set(names)];
      for (const name of unique) path(name);
      for (const name of unique) readers.set(name, (readers.get(name) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const name of unique) {
          const count = readers.get(name)! - 1;
          if (count) readers.set(name, count);
          else {
            readers.delete(name);
            if (retired.delete(name)) {
              try { remove(name); } catch { console.error('Encrypted image cleanup deferred until restart.'); }
            }
          }
        }
      };
    },
    async readAsync(name: string) { return envelopeSchema.parse(JSON.parse(await readFile(path(name), 'utf8'))); },
    snapshotBytes(name: string) { return statSync(snapshotPath(name)).size; },
    writeSnapshot(snapshot: PublicSnapshot) {
      const serialized = JSON.stringify(publicSnapshotSchema.parse(snapshot));
      const name = `${randomUUID()}.public.json`;
      try {
        writeFileSync(snapshotPath(name), serialized, { flag: 'wx', mode: 0o600, flush: true });
        // Persist the public file and directory entry before committing its DB reference.
        const fd = openSync(root, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        return name;
      } catch (error) { removeSnapshot(name); throw error; }
    },
    readSnapshot(name: string) { return publicSnapshotSchema.parse(JSON.parse(readFileSync(snapshotPath(name), 'utf8'))); },
    removeSnapshot,
    sweepSnapshots(referenced: Set<string>) {
      for (const name of readdirSync(root)) if (snapshotPattern.test(name) && !referenced.has(name)) removeSnapshot(name);
    },
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
