// Shared JSON body encoding for R2 archive objects.
//
// Archive objects are stored as gzip when the runtime supports
// CompressionStream and the compressed form is actually smaller. Readers
// auto-detect the gzip magic bytes, so objects written before this change
// (plain JSON text) keep working unchanged. Test doubles that only expose
// `.json()` are still supported through the fallback branch.

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;
const DEFAULT_MIN_BYTES = 1024;

export function gzipSupported() {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

export async function encodeJsonBody(value, { minBytes = DEFAULT_MIN_BYTES } = {}) {
  const text = JSON.stringify(value);
  const rawBytes = new TextEncoder().encode(text).byteLength;
  if (!gzipSupported() || rawBytes < minBytes) return { body: text, bytes: rawBytes, encoding: null };
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    if (compressed.byteLength >= rawBytes) return { body: text, bytes: rawBytes, encoding: null };
    return { body: compressed, bytes: compressed.byteLength, encoding: 'gzip' };
  } catch (_) {
    return { body: text, bytes: rawBytes, encoding: null };
  }
}

export async function decodeJsonBody(object) {
  if (!object) return null;
  if (typeof object.arrayBuffer === 'function') {
    const buffer = await object.arrayBuffer();
    return parseJsonBytes(new Uint8Array(buffer));
  }
  if (typeof object.json === 'function') return await object.json();
  if (typeof object.text === 'function') return JSON.parse(await object.text());
  return null;
}

// A gzip object can decompress many times larger than its stored size; cap
// the decompressed bytes so a crafted archive cannot exhaust Worker memory.
const R2_BODY_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

export async function parseJsonBytes(bytes) {
  if (bytes.byteLength >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1 && typeof DecompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > R2_BODY_MAX_DECOMPRESSED_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('r2_body_decompressed_too_large');
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(merged));
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function httpMetadataFor(encoding, contentType = 'application/json; charset=utf-8') {
  return encoding === 'gzip'
    ? { contentType, contentEncoding: 'gzip' }
    : { contentType };
}
