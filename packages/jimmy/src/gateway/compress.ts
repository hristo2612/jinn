import zlib from "node:zlib";
import type { Transform } from "node:stream";

export type Encoding = "br" | "gzip";

/** Responses smaller than this aren't worth the compression overhead. */
export const MIN_COMPRESS_BYTES = 1024;

const COMPRESSIBLE_EXT = new Set([
  ".js",
  ".css",
  ".html",
  ".json",
  ".svg",
  ".map",
  ".txt",
  ".webmanifest",
]);

/** Pick the best encoding the client accepts, preferring brotli. */
export function pickEncoding(acceptEncoding: string | undefined): Encoding | null {
  if (!acceptEncoding) return null;
  const ae = acceptEncoding.toLowerCase();
  if (ae.includes("br")) return "br";
  if (ae.includes("gzip")) return "gzip";
  return null;
}

export function isCompressibleExt(ext: string): boolean {
  return COMPRESSIBLE_EXT.has(ext.toLowerCase());
}

// Quality tuned for on-the-fly compression: meaningful ratio without burning CPU.
const BROTLI_OPTS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } };
const GZIP_OPTS = { level: 6 };

/** Streaming compressor for piping files. */
export function compressStream(enc: Encoding): Transform {
  return enc === "br" ? zlib.createBrotliCompress(BROTLI_OPTS) : zlib.createGzip(GZIP_OPTS);
}

/** One-shot compressor for in-memory bodies (e.g. JSON). */
export function compressBuffer(enc: Encoding, buf: Buffer): Buffer {
  return enc === "br" ? zlib.brotliCompressSync(buf, BROTLI_OPTS) : zlib.gzipSync(buf, GZIP_OPTS);
}
