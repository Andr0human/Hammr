import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import type { GenMsg, RawEvent, Scenario } from '@hammr/shared';
import { logger } from '../logger.js';
import { LoadEventsWriter } from '../db/events-writer.js';
import { Aggregator } from './aggregator.js';
import type { GeneratorPool } from './gen-pool.js';
import { splitVUs } from './split-vus.js';

export type TestState = 'queued' | 'running' | 'stopping' | 'completed' | 'failed';
export type TestEndReason = 'completed' | 'failed' | 'aborted';

interface ActiveTest {
  testId: string;
  scenario: Scenario;
  totalVUs: number;
  rampUpMs: number;
  durationMs: number;
  startedAt: number;
  state: TestState;
  // Per-generator slice of VUs and a flag set when their `done` arrives.
  perGen: Map<string, { vus: number; done: boolean }>;
  totalEvents: number;
  totalErrors: number;
  droppedEvents: number;
  durationTimer: NodeJS.Timeout;
  // Cleared on settle so flushTimer doesn't keep firing forever.
  flushTimer: NodeJS.Timeout;
  endError?: string;
}

export interface StartTestParams {
  scenario: Scenario;
  rampUpMs: number;
  durationMs: number;
}

export interface OrchestratorOptions {
  clickhouse?: ClickHouseClient;
  // Set to false to skip cold-path writes (useful for tests / offline demos).
  writeColdPath?: boolean;
  // Per-second flush cadence for the hot-path aggregator (logging tick).
  flushIntervalMs?: number;
}

export interface TestResult {
  testId: string;
  state: TestState;
  endReason: TestEndReason;
  totalEvents: number;
  errors: number;
  droppedEvents: number;
  durationMs: number;
  error?: string;
}

const FLUSH_INTERVAL = 1000;

// Owns the single active test (v1 invariant: one at a time). Coordinates the
// generator pool, the in-memory aggregator, and the cold-path writer.
//
// Why one orchestrator (not one per test)? Because v1 only ever runs one test;
// per-test instances would be dead weight. When V2 lifts the invariant we'll
// keep an orchestrator per testId in a Map, which is a strict superset of this.
export class Orchestrator {
  private active: ActiveTest | null = null;
  private aggregator: Aggregator | null = null;
  private writer: LoadEventsWriter | null = null;
  private pendingResolve: ((r: TestResult) => void) | null = null;
  private readonly poolUnsub: () => void;

  constructor(
    private readonly pool: GeneratorPool,
    private readonly opts: OrchestratorOptions = {},
  ) {
    // Abort-on-disconnect (CLAUDE.md Session 5 / failure semantics): if any
    // generator carrying part of the active test drops, fail the whole test.
    this.poolUnsub = pool.on((ev) => {
      if (ev.type !== 'disconnected') return;
      if (!this.active) return;
      if (!this.active.perGen.has(ev.generatorId)) return;
      this.fail(`generator ${ev.generatorId} disconnected mid-test`);
    });
  }

  // True if a test is queued/running/stopping. POST /api/tests must 409 in that case.
  isBusy(): boolean {
    return this.active !== null && this.active.state !== 'completed' && this.active.state !== 'failed';
  }

  activeTestId(): string | null {
    return this.active?.testId ?? null;
  }

  // Caller awaits the returned Promise to learn how the test ended. Throws
  // synchronously on validation errors (no gens, busy, bad config).
  async startTest(params: StartTestParams): Promise<TestResult> {
    if (this.isBusy()) {
      throw new Error(`controller busy: test ${this.active!.testId} is ${this.active!.state}`);
    }
    const gens = this.pool.list();
    if (gens.length === 0) {
      throw new Error('no generators registered');
    }
    const totalVUs = params.scenario.config.users;
    const split = splitVUs(totalVUs, gens.map((g) => g.generatorId));

    const testId = randomUUID();
    const startedAt = Date.now();

    this.aggregator = new Aggregator();
    if (this.opts.writeColdPath !== false && this.opts.clickhouse) {
      this.writer = new LoadEventsWriter(this.opts.clickhouse, { testId });
    }

    const perGen = new Map<string, { vus: number; done: boolean }>();
    for (const g of gens) {
      const vus = split.get(g.generatorId) ?? 0;
      perGen.set(g.generatorId, { vus, done: false });
    }

    // Duration timer: send `stop` to every gen when the test's wall time elapses.
    // Generators also enforce durationMs locally (their VU loops check endAt),
    // so this is belt-and-suspenders — but the protocol message is what the
    // spec calls out, so we send it.
    const durationTimer = setTimeout(() => {
      logger.info({ testId }, 'duration elapsed; broadcasting stop');
      this.broadcastStop();
    }, params.durationMs);
    durationTimer.unref();

    const flushTimer = setInterval(
      () => this.tick(),
      this.opts.flushIntervalMs ?? FLUSH_INTERVAL,
    );
    flushTimer.unref();

    this.active = {
      testId,
      scenario: params.scenario,
      totalVUs,
      rampUpMs: params.rampUpMs,
      durationMs: params.durationMs,
      startedAt,
      state: 'running',
      perGen,
      totalEvents: 0,
      totalErrors: 0,
      droppedEvents: 0,
      durationTimer,
      flushTimer,
    };

    // Send `start` to each generator with its slice of VUs.
    for (const g of gens) {
      const vus = split.get(g.generatorId) ?? 0;
      try {
        g.send({
          type: 'start',
          testId,
          scenario: params.scenario,
          vus,
          rampUpMs: params.rampUpMs,
          durationMs: params.durationMs,
        });
      } catch (err) {
        // If we can't even reach a gen on send, fail the test immediately —
        // the abort-on-disconnect listener won't fire because we never made it
        // far enough for the WS to formally close.
        this.fail(`failed to dispatch start to ${g.generatorId}: ${(err as Error).message}`);
        return new Promise((resolve) => {
          this.pendingResolve = resolve;
        });
      }
    }

    logger.info(
      {
        testId,
        totalVUs,
        rampUpMs: params.rampUpMs,
        durationMs: params.durationMs,
        generators: gens.length,
        split: Object.fromEntries(split),
      },
      'test started',
    );

    return new Promise<TestResult>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  // Manually abort a running test (called by DELETE /api/tests/:id in Session 6;
  // unused via REST in Session 5 but plumbed so the protocol matches the spec).
  stop(testId: string): void {
    if (!this.active || this.active.testId !== testId) {
      throw new Error(`test ${testId} is not active`);
    }
    if (this.active.state !== 'running') return;
    this.active.state = 'stopping';
    logger.info({ testId }, 'stop requested');
    this.broadcastStop();
  }

  // Called by the WS server for every inbound generator message. Routes to the
  // active test; messages for stale/unknown tests are ignored (defensive — a
  // delayed batch from a previous test could land after a new one started).
  handleMessage(generatorId: string, msg: GenMsg): void {
    if (msg.type === 'register' || msg.type === 'pong') return;
    if (!this.active) return;
    if (msg.type !== 'metrics' && msg.type !== 'done' && msg.type !== 'error') return;
    if (msg.testId !== this.active.testId) {
      logger.debug(
        { from: generatorId, msgType: msg.type, msgTestId: msg.testId, active: this.active.testId },
        'dropping message for non-active test',
      );
      return;
    }

    switch (msg.type) {
      case 'metrics':
        this.onMetrics(generatorId, msg.batch, msg.droppedEvents ?? 0);
        break;
      case 'done':
        this.onDone(generatorId, msg.stats);
        break;
      case 'error':
        this.fail(`generator ${generatorId} reported error: ${msg.message}`);
        break;
    }
  }

  shutdown(): void {
    this.poolUnsub();
    if (this.active) {
      clearTimeout(this.active.durationTimer);
      clearInterval(this.active.flushTimer);
    }
  }

  private onMetrics(generatorId: string, batch: RawEvent[], dropped: number): void {
    if (!this.active || !this.aggregator) return;
    this.active.totalEvents += batch.length;
    this.active.droppedEvents += dropped;
    for (const e of batch) {
      if (e.statusCode === 0 || e.statusCode >= 400) this.active.totalErrors++;
    }
    this.aggregator.addBatch(batch);
    // Cold path: same raw events into ClickHouse via the batched writer.
    this.writer?.push(batch);
    if (dropped > 0) {
      logger.warn({ generatorId, dropped, testId: this.active.testId }, 'generator dropped events');
    }
  }

  private onDone(generatorId: string, stats: { totalEvents: number; errors: number }): void {
    if (!this.active) return;
    const slot = this.active.perGen.get(generatorId);
    if (!slot) return;
    slot.done = true;
    logger.info(
      { generatorId, testId: this.active.testId, stats },
      'generator reported done',
    );
    const allDone = Array.from(this.active.perGen.values()).every((s) => s.done);
    if (allDone) this.complete();
  }

  private broadcastStop(): void {
    if (!this.active) return;
    for (const generatorId of this.active.perGen.keys()) {
      const entry = this.pool.get(generatorId);
      if (!entry) continue;
      try {
        entry.send({ type: 'stop', testId: this.active.testId });
      } catch (err) {
        logger.warn({ generatorId, err }, 'failed to send stop');
      }
    }
  }

  // Tick on the flush interval: drain closed buckets from the aggregator and
  // log them. Session 6 swaps the log line for a Socket.IO emit.
  private tick(): void {
    if (!this.active || !this.aggregator) return;
    const closed = this.aggregator.flushClosed();
    for (const m of closed) {
      logger.info(
        {
          testId: this.active.testId,
          second: m.second,
          step: m.stepName,
          rps: m.rps,
          p50: m.p50,
          p95: m.p95,
          p99: m.p99,
          errPct: Number((m.errorRate * 100).toFixed(2)),
          bytes: m.bytesPerSec,
        },
        'live metric',
      );
    }
  }

  private complete(): void {
    if (!this.active) return;
    this.active.state = 'completed';
    void this.settle('completed');
  }

  private fail(reason: string): void {
    if (!this.active || this.active.state === 'completed' || this.active.state === 'failed') return;
    this.active.state = 'failed';
    this.active.endError = reason;
    logger.error({ testId: this.active.testId, reason }, 'test failed');
    // Broadcast stop so any still-running gen winds down (best-effort; the
    // disconnected gen will already be unreachable, but others may carry on).
    this.broadcastStop();
    void this.settle('failed');
  }

  // Drains the aggregator + writer, computes the final result, and resolves
  // the Promise returned from startTest(). Idempotent: guards on `pendingResolve`.
  private async settle(reason: TestEndReason): Promise<void> {
    const t = this.active;
    if (!t) return;
    clearTimeout(t.durationTimer);
    clearInterval(t.flushTimer);

    // One last flush of whatever is still in-memory so the final partial second
    // hits the log even if the test ended mid-bucket.
    if (this.aggregator) {
      const tail = this.aggregator.drainAll();
      for (const m of tail) {
        logger.info(
          {
            testId: t.testId,
            second: m.second,
            step: m.stepName,
            rps: m.rps,
            p50: m.p50,
            p95: m.p95,
            p99: m.p99,
            errPct: Number((m.errorRate * 100).toFixed(2)),
            bytes: m.bytesPerSec,
            tail: true,
          },
          'live metric (tail)',
        );
      }
    }

    if (this.writer) {
      try {
        await this.writer.close();
      } catch (err) {
        logger.error({ err, testId: t.testId }, 'writer close failed');
      }
    }

    const result: TestResult = {
      testId: t.testId,
      state: t.state,
      endReason: reason,
      totalEvents: t.totalEvents,
      errors: t.totalErrors,
      droppedEvents: t.droppedEvents,
      durationMs: Date.now() - t.startedAt,
      error: t.endError,
    };

    logger.info(
      {
        testId: t.testId,
        endReason: reason,
        totalEvents: result.totalEvents,
        errors: result.errors,
        droppedEvents: result.droppedEvents,
        durationMs: result.durationMs,
      },
      'test settled',
    );

    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.active = null;
    this.aggregator = null;
    this.writer = null;
    resolve?.(result);
  }
}
