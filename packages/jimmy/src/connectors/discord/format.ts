const DISCORD_MAX_LENGTH = 2000;

export function formatResponse(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf("\n", DISCORD_MAX_LENGTH);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf(" ", DISCORD_MAX_LENGTH);
    if (cutAt <= 0) cutAt = DISCORD_MAX_LENGTH;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}

export async function downloadAttachment(
  url: string,
  destDir: string,
  filename: string,
): Promise<string> {
  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  const destPath = path.join(destDir, filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download attachment: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  return destPath;
}
