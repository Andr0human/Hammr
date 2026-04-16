// Minimal duration parser for the CLI. Session 3's scenario parser replaces this
// with zod-backed validation; for now we only need "30s" / "5min" / "500ms".

const RE = /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins)$/i;

export function parseDuration(input: string): number {
  const m = RE.exec(input.trim());
  if (!m) throw new Error(`Invalid duration: ${input} (expected e.g. "30s", "5min", "500ms")`);
  const value = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  switch (unit) {
    case 'ms':
      return Math.round(value);
    case 's':
    case 'sec':
    case 'secs':
      return Math.round(value * 1000);
    case 'm':
    case 'min':
    case 'mins':
      return Math.round(value * 60_000);
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}
