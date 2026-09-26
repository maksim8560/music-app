/* ==========================================================================
   audio/files.js — local file import
   Reads ID3v2 tags (title / artist / album / cover art) straight from the
   first 512 KB, so imported tracks look first-class without a server.
   ========================================================================== */

import { hash, hsl, rgbToHex } from '../core/prng.js';

const TAG_READ_BYTES = 512 * 1024;

/* ------------------------------ ID3v2 ----------------------------------- */
const decoder = new TextDecoder('utf-8', { fatal: false });

const syncsafe = (view, off) =>
  (view.getUint8(off) << 21) | (view.getUint8(off + 1) << 14) | (view.getUint8(off + 2) << 7) | view.getUint8(off + 3);

const latin1 = (bytes) => String.fromCharCode(...bytes);

function readText(view, start, end, encoding) {
  if (end <= start) return '';
  const bytes = new Uint8Array(view.buffer, view.byteOffset + start, end - start);
  try {
    if (encoding === 1) {
      const be = bytes[0] === 0xfe && bytes[1] === 0xff;
      const body = bytes.subarray(be ? 2 : 2);
      const le = be ? false : true;
      let out = '';
      for (let i = 0; i + 1 < body.length; i += 2) {
        out += String.fromCharCode(le ? body[i] | (body[i + 1] << 8) : (body[i] << 8) | body[i + 1]);
      }
      return out.replace(/\0+$/, '');
    }
    if (encoding === 2) {
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out.replace(/\0+$/, '');
    }
    if (encoding === 3) return decoder.decode(bytes).replace(/\0+$/, '');
    return latin1(Array.from(bytes).filter((b) => b)).replace(/\0+$/, '');
  } catch {
    return '';
  }
}

function findTerminator(view, start, end, wide) {
  if (wide) {
    for (let i = start; i + 1 < end; i += 2) {
      if (view.getUint8(i) === 0 && view.getUint8(i + 1) === 0) return i;
    }
    return end;
  }
  for (let i = start; i < end; i++) if (view.getUint8(i) === 0) return i;
  return end;
}

/** Parse the ID3v2 header of a buffer slice. Returns {} when absent. */
export function parseID3(buffer) {
  const out = { title: '', artist: '', album: '', cover: null };
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 10) return out;
    if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x44 || view.getUint8(2) !== 0x33) return out; // "ID3"

    const major = view.getUint8(3);
    const tagSize = Math.min(syncsafe(view, 6), view.byteLength - 10);
    const idLen = major === 2 ? 3 : 4;
    const sizeLen = major === 2 ? 3 : 4;
    const headLen = idLen + sizeLen + (major === 2 ? 0 : 2);

    let p = 10;
    const end = 10 + tagSize;
    let guard = 0;

    while (p + headLen <= end && guard++ < 128) {
      const id = major === 2
        ? latin1([view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2)])
        : latin1([view.getUint8(p), view.getUint8(p + 1), view.getUint8(p + 2), view.getUint8(p + 3)]);

      if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

      let frameSize;
      if (major === 2) frameSize = (view.getUint8(p + 3) << 16) | (view.getUint8(p + 4) << 8) | view.getUint8(p + 5);
      else if (major === 4) frameSize = syncsafe(view, p + 4);
      else frameSize = (view.getUint8(p + 4) << 24) | (view.getUint8(p + 5) << 16) | (view.getUint8(p + 6) << 8) | view.getUint8(p + 7);

      const dataStart = p + headLen;
      const dataEnd = Math.min(dataStart + frameSize, end);
      if (frameSize <= 0 || dataEnd <= dataStart) {
        p = dataStart + 1;
        continue;
      }

      if (id === 'TIT2' || id === 'TT2') out.title = readText(view, dataStart + 1, dataEnd, view.getUint8(dataStart));
      else if (id === 'TPE1' || id === 'TP1') out.artist = readText(view, dataStart + 1, dataEnd, view.getUint8(dataStart));
      else if (id === 'TALB' || id === 'TAL') out.album = readText(view, dataStart + 1, dataEnd, view.getUint8(dataStart));
      else if (id === 'APIC' || id === 'PIC') {
        const enc = view.getUint8(dataStart);
        let q = dataStart + 1;
        if (id === 'PIC') {
          q += 3; // image format
        } else {
          const mimeEnd = findTerminator(view, q, dataEnd, false);
          q = mimeEnd + 1;
        }
        q += 1; // picture type
        const descEnd = findTerminator(view, q, dataEnd, enc === 1 || enc === 2);
        q = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
        if (q < dataEnd) {
          out.cover = new Blob([new Uint8Array(buffer, q, dataEnd - q)], { type: 'image/jpeg' });
        }
      }
      p = dataEnd;
    }
  } catch (err) {
    console.warn('[files] ID3 parse failed', err);
  }
  return out;
}

/* --------------------------- track construction ------------------------- */

const AUDIO_RE = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|webb|webm)$/i;

export const isAudioFile = (file) => AUDIO_RE.test(file.name) || file.type.startsWith('audio/');

/** Stable hue pair derived from the file name — every import gets its own art */
function paletteFor(seedStr) {
  const h = hash(seedStr);
  const base = h % 360;
  return [rgbToHex(hsl(base, 0.72, 0.62)), rgbToHex(hsl((base + 48 + (h % 60)) % 360, 0.68, 0.58))];
}

export async function makeLocalTrack(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const dashParts = name.split(/\s+[-–—]\s+/);
  const tags = { title: '', artist: '', album: '', cover: null };

  if (/mp3/i.test(file.type) || /\.mp3$/i.test(file.name)) {
    try {
      const head = await file.slice(0, TAG_READ_BYTES).arrayBuffer();
      Object.assign(tags, parseID3(head));
    } catch { /* not an ID3 file — filename fallback below */ }
  }

  const title = tags.title || (dashParts.length > 1 ? dashParts.slice(1).join(' – ') : name);
  const artist = tags.artist || (dashParts.length > 1 ? dashParts[0] : 'Локальный файл');
  const [c1, c2] = paletteFor(file.name + file.size);
  const mpegYear = tags.year ? Number(tags.year) : null;

  return {
    id: `local:${file.name}:${file.size}`,
    title,
    artist,
    album: tags.album || 'Загруженные файлы',
    year: mpegYear || new Date(file.lastModified).getFullYear(),
    genre: 'Локальный',
    genreKey: 'local',
    duration: 0, // filled in after decoding
    colors: [c1, c2],
    blurb: `${file.name} · ${(file.size / 1048576).toFixed(1)} МБ`,
    coverUrl: tags.cover ? URL.createObjectURL(tags.cover) : null,
    source: 'file',
    file,
    size: file.size,
  };
}

export function revokeCovers(tracks) {
  for (const t of tracks) if (t.coverUrl) URL.revokeObjectURL(t.coverUrl);
}
