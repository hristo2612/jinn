const WA_MAX_LENGTH = 4000;

export function formatResponse(text: string): string[] {
  if (text.length <= WA_MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= WA_MAX_LENGTH) { chunks.push(remaining); break; }
    let cutAt = remaining.lastIndexOf("\n", WA_MAX_LENGTH);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf(" ", WA_MAX_LENGTH);
    if (cutAt <= 0) cutAt = WA_MAX_LENGTH;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}
