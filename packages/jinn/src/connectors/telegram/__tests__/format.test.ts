import { describe, it, expect } from "vitest";
import { markdownToTelegram, formatResponse, stripTelegramMarkdown } from "../format.js";

describe("markdownToTelegram", () => {
  describe("headings", () => {
    it("converts markdown headings to bold text", () => {
      expect(markdownToTelegram("# Heading 1")).toBe("*Heading 1*");
      expect(markdownToTelegram("## Heading 2")).toBe("*Heading 2*");
      expect(markdownToTelegram("### Heading 3")).toBe("*Heading 3*");
    });
  });

  describe("bold", () => {
    it("preserves **bold** as *bold*", () => {
      expect(markdownToTelegram("**bold text**")).toBe("*bold text*");
    });

    it("converts __bold__ to *bold*", () => {
      expect(markdownToTelegram("__bold text__")).toBe("*bold text*");
    });
  });

  describe("italic", () => {
    it("converts single *italic* to _italic_", () => {
      expect(markdownToTelegram("*italic text*")).toBe("_italic text_");
    });
  });

  describe("strikethrough", () => {
    it("preserves ~~strikethrough~~", () => {
      expect(markdownToTelegram("~~deleted~~")).toBe("~deleted~");
    });
  });

  describe("links", () => {
    it("converts markdown links to Telegram inline links", () => {
      expect(markdownToTelegram("[Google](https://google.com)")).toBe(
        "[Google](https://google.com)",
      );
    });
  });

  describe("bullet lists", () => {
    it("converts - items to bullet points", () => {
      expect(markdownToTelegram("- item one\n- item two")).toBe(
        "• item one\n• item two",
      );
    });

    it("converts * items to bullet points", () => {
      expect(markdownToTelegram("* item one\n* item two")).toBe(
        "• item one\n• item two",
      );
    });

    it("preserves indentation", () => {
      expect(markdownToTelegram("  - nested")).toBe("  • nested");
    });
  });

  describe("code blocks", () => {
    it("preserves inline code untouched", () => {
      expect(markdownToTelegram("`**not bold**`")).toBe("`**not bold**`");
    });

    it("preserves fenced code blocks untouched", () => {
      const input = "```\n**not bold**\n```";
      expect(markdownToTelegram(input)).toBe(input);
    });
  });

  describe("mixed content", () => {
    it("handles mixed markdown correctly", () => {
      const input = "## Title\n\n**Bold** and ~~deleted~~ with `code`";
      const expected = "*Title*\n\n*Bold* and ~deleted~ with `code`";
      expect(markdownToTelegram(input)).toBe(expected);
    });
  });
});

describe("formatResponse", () => {
  it("returns a single chunk for short messages", () => {
    const result = formatResponse("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("splits long messages at newline boundaries", () => {
    const line = "A".repeat(4000);
    const input = `${line}\n${"B".repeat(4000)}`;
    const result = formatResponse(input);
    expect(result.length).toBe(2);
    expect(result[0]).toBe(line);
  });

  it("applies markdown conversion before chunking", () => {
    const result = formatResponse("## Hello");
    expect(result).toEqual(["*Hello*"]);
  });
});

describe("stripTelegramMarkdown", () => {
  it("preserves OAuth query parameter names in the plain-text fallback", () => {
    const url =
      "https://claude.ai/oauth/authorize?client_id=client123&redirect_uri=http%3A%2F%2Flocalhost%3A54321%2Fcallback&state=state123";

    expect(stripTelegramMarkdown(`Continue authentication:\n${url}`)).toContain(url);
  });

  it("keeps markdown delimiters outside URLs and preserves unknown placeholders", () => {
    const url = "https://github.com/jinn/jinn/releases/tag/v0.33.0";
    expect(stripTelegramMarkdown(`**Release notes: ${url}**`)).toBe(`Release notes: ${url}`);
    expect(stripTelegramMarkdown(`*x ${url}*`)).toBe(`x ${url}`);
    expect(stripTelegramMarkdown("\x00URL0\x00")).toBe("\x00URL0\x00");
  });
});
