export function takeSnippet(content: string, query: string, radius = 8): string {
  const lines = content.split(/\r?\n/);
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return lines.slice(0, 80).join("\n");
  }
  const hit = lines.findIndex((line) => line.toLowerCase().includes(needle));
  if (hit < 0) {
    return lines.slice(0, 80).join("\n");
  }
  const start = Math.max(0, hit - radius);
  const end = Math.min(lines.length, hit + radius + 1);
  return lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");
}

export function compactWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
