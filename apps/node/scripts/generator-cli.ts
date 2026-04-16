// Session 2 standalone demo: runs the VU pool directly, bypassing controller/ws.
//
// Usage:
//   tsx apps/node/scripts/generator-cli.ts <url> --vus 100 --ramp 30s --dur 60s \
//     [--think 200] [--threads 4]
import { runTest } from '../src/generator/pool.js';
import { parseDuration } from '../src/generator/duration.js';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`missing ${name}`);
    usage();
    process.exit(1);
  }
  return value;
}

function usage(): void {
  console.error(
    'usage: generator-cli <url> --vus <n> --ramp <dur> --dur <dur> [--think <ms>] [--threads <n>]',
  );
}

const url = process.argv[2];
if (!url || url.startsWith('--')) {
  usage();
  process.exit(1);
}

const vus = Number(required('--vus', flag('--vus')));
const rampUpMs = parseDuration(required('--ramp', flag('--ramp')));
const durationMs = parseDuration(required('--dur', flag('--dur')));
const thinkTimeMs = flag('--think') ? Number(flag('--think')) : 0;
const threadCount = flag('--threads') ? Number(flag('--threads')) : undefined;

if (!Number.isFinite(vus) || vus < 1) {
  console.error('--vus must be a positive integer');
  process.exit(1);
}
if (durationMs <= rampUpMs) {
  console.error('--dur must be greater than --ramp');
  process.exit(1);
}

let seen = 0;
const result = await runTest({
  url,
  totalVUs: vus,
  rampUpMs,
  durationMs,
  thinkTimeMs,
  threadCount,
  onMetrics: (batch) => {
    seen += batch.length;
  },
});

const latencies = result.events.map((e) => e.latencyMs).sort((a, b) => a - b);
const q = (p: number): number =>
  latencies.length ? (latencies[Math.floor((latencies.length - 1) * p)] ?? 0) : 0;
const elapsedSec = result.durationMs / 1000;

console.log('');
console.log(`generatorId:   ${result.generatorId}`);
console.log(`elapsed (s):   ${elapsedSec.toFixed(2)}`);
console.log(`events:        ${result.totalEvents} (live-stream saw ${seen})`);
console.log(`errors:        ${result.errors}`);
console.log(`rps (avg):     ${(result.totalEvents / elapsedSec).toFixed(1)}`);
console.log(`p50 (ms):      ${q(0.5).toFixed(1)}`);
console.log(`p95 (ms):      ${q(0.95).toFixed(1)}`);
console.log(`p99 (ms):      ${q(0.99).toFixed(1)}`);
console.log(`max (ms):      ${(latencies.at(-1) ?? 0).toFixed(1)}`);
