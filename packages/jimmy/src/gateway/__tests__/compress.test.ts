import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import {
  pickEncoding,
  isCompressibleExt,
  compressBuffer,
  compressStream,
} from "../compress.js";

describe("pickEncoding", () => {
  it("prefers brotli when both are accepted", () => {
    expect(pickEncoding("gzip, deflate, br")).toBe("br");
  });

  it("falls back to gzip when brotli is absent", () => {
    expect(pickEncoding("gzip, deflate")).toBe("gzip");
  });

  it("returns null when nothing usable is accepted", () => {
    expect(pickEncoding("deflate")).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
    expect(pickEncoding("")).toBeNull();
  });
});

describe("isCompressibleExt", () => {
  it("compresses text-like assets", () => {
    expect(isCompressibleExt(".js")).toBe(true);
    expect(isCompressibleExt(".CSS")).toBe(true);
    expect(isCompressibleExt(".json")).toBe(true);
  });

  it("skips already-compressed binaries", () => {
    expect(isCompressibleExt(".png")).toBe(false);
    expect(isCompressibleExt(".woff2")).toBe(false);
  });
});

describe("compressBuffer", () => {
  it("produces output the standard decompressors can reverse", () => {
    const original = Buffer.from(JSON.stringify({ hello: "world".repeat(500) }));

    const gz = compressBuffer("gzip", original);
    expect(zlib.gunzipSync(gz).toString()).toBe(original.toString());
    expect(gz.length).toBeLessThan(original.length);

    const br = compressBuffer("br", original);
    expect(zlib.brotliDecompressSync(br).toString()).toBe(original.toString());
    expect(br.length).toBeLessThan(original.length);
  });
});

describe("compressStream", () => {
  it("round-trips through a gzip stream", async () => {
    const original = Buffer.from("x".repeat(5000));
    const chunks: Buffer[] = [];
    const stream = compressStream("gzip");
    const done = new Promise<void>((resolve) => {
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => resolve());
    });
    stream.end(original);
    await done;
    expect(zlib.gunzipSync(Buffer.concat(chunks)).toString()).toBe(original.toString());
  });
});
