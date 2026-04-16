import { request, type Dispatcher } from 'undici';
import type { RawEvent } from '@hammr/shared';

export interface VUContext {
  vuId: number;
  threadId: number;
  generatorId: string;
  url: string;
  thinkTimeMs: number;
  // Absolute deadline in performance.now() units. The VU stops when we pass it.
  endAt: number;
}

export type EventSink = (event: RawEvent) => void;

// Session 2 placeholder: one GET per iteration. Session 3 swaps this for the
// scenario-driven multi-step flow with extract + interpolation.
const STEP_NAME = 'request';

export async function runVU(
  ctx: VUContext,
  agent: Dispatcher,
  sink: EventSink,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted && performance.now() < ctx.endAt) {
    const t0 = performance.now();
    let statusCode = 0;
    let responseBytes = 0;

    try {
      const res = await request(ctx.url, { dispatcher: agent, signal });
      statusCode = res.statusCode;
      for await (const chunk of res.body) {
        responseBytes += (chunk as Buffer).length;
      }
    } catch {
      // Network-level failure. statusCode 0 signals "no response" downstream.
    }

    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    sink({
      stepName: STEP_NAME,
      statusCode,
      latencyMs,
      responseBytes,
      timestamp: Date.now(),
      generatorId: ctx.generatorId,
      threadId: ctx.threadId,
      vuId: ctx.vuId,
    });

    if (ctx.thinkTimeMs > 0 && !signal.aborted && performance.now() < ctx.endAt) {
      await sleep(ctx.thinkTimeMs, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
