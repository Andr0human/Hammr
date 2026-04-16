import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { logger } from '../../logger.js';
import { parseScenario } from '../../scenario/parse.js';
import type { GeneratorPool } from '../gen-pool.js';
import type { Orchestrator } from '../orchestrator.js';

export interface RestServerOptions {
  port: number;
}

export interface RestServer {
  close: () => Promise<void>;
}

// REST stub for Session 5 — just enough to kick off a coordinated test from a
// CLI. SQLite persistence, listing, and DELETE come in Session 6 along with
// the proper validation contract.
export async function startRestServer(
  pool: GeneratorPool,
  orch: Orchestrator,
  opts: RestServerOptions,
): Promise<RestServer> {
  const app = express();
  // Limit matches CLAUDE.md ("scenario files larger than 1 MB are rejected at the edge").
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, generators: pool.size(), busy: orch.isBusy() });
  });

  app.get('/api/generators', (_req: Request, res: Response) => {
    res.json({
      generators: pool.list().map((g) => ({
        generatorId: g.generatorId,
        cores: g.cores,
        maxVUs: g.maxVUs,
        registeredAt: g.registeredAt,
      })),
    });
  });

  // Session 5 stub: parse + dispatch a test, return testId immediately.
  // The actual settle happens asynchronously; the CLI can watch controller
  // logs (Session 6 wires GET /api/tests/:id to read status from SQLite).
  app.post('/api/tests', (req: Request, res: Response) => {
    let parsed;
    try {
      parsed = parseScenario(req.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }

    if (orch.isBusy()) {
      res.status(409).json({ error: `controller busy: ${orch.activeTestId()} is running` });
      return;
    }

    // startTest's body runs synchronously up to the trailing `return new Promise`,
    // so by the time the call returns, this.active is either set or startTest
    // has already turned a thrown error into a rejected Promise.
    const settle = orch.startTest({
      scenario: parsed.scenario,
      rampUpMs: parsed.rampUpMs,
      durationMs: parsed.durationMs,
    });
    const testId = orch.activeTestId();

    if (!testId) {
      settle
        .catch((err) => res.status(409).json({ error: (err as Error).message }))
        // Match Express's expectation that we end the response.
        .finally(() => undefined);
      return;
    }

    res.status(202).json({ testId, status: 'running' });
    settle
      .then((result) => logger.info({ result }, 'test settled (background)'))
      .catch((err) => logger.error({ err }, 'test failed (background)'));
  });

  const server: Server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(opts.port, () => resolve(s));
    s.once('error', reject);
  });
  logger.info({ port: opts.port }, 'REST server listening');

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
