import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeBase64url, parsePublicKey } from './crypto.mjs';

// Only durable enrollment belongs here. Sessions, codes and live sockets never do.
export function phoneStore(file, {username, publicOrigin}) {
  if (!file) return {load: () => null, save: () => {}, clear: () => {}};
  const filename = path.resolve(file);
  return {
    clear() {
      try { unlinkSync(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    load() {
      let text;
      try { text = readFileSync(filename, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      try {
        const saved = JSON.parse(text);
        const phone = saved.phone;
        if (saved.version !== 1 || saved.username !== username || saved.publicOrigin !== publicOrigin
            || !phone || typeof phone.id !== 'string' || !/^[a-f0-9-]{36}$/.test(phone.id)
            || typeof phone.label !== 'string' || !phone.label.trim() || phone.label.length > 40) {
          throw new Error('Invalid enrollment');
        }
        decodeBase64url(phone.deviceToken, 32, 32);
        return {id: phone.id, label: phone.label, deviceToken: phone.deviceToken,
          key: parsePublicKey(phone.publicKey), socket: null};
      } catch {
        // Never silently erase enrollment and reopen password-only setup.
        throw new Error('Saved phone pairing is invalid or belongs to a different account/origin. Restore the pairing file or use a separate PAIRING_FILE.');
      }
    },
    save(phone) {
      const directory = path.dirname(filename);
      mkdirSync(directory, {recursive: true, mode: 0o700});
      const temporary = path.join(directory, `.phone-${randomUUID()}.tmp`);
      const data = JSON.stringify({version: 1, username, publicOrigin, phone: {
        id: phone.id, label: phone.label, deviceToken: phone.deviceToken,
        publicKey: phone.key.export({format: 'der', type: 'spki'}).toString('base64url'),
      }}) + '\n';
      let descriptor;
      try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, data, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, filename);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    },
  };
}
