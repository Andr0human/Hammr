import { logger } from '../logger.js';
import { env } from '../env.js';
import { getClickHouse } from '../db/clickhouse.js';
import { TestsDao } from '../db/tests-dao.js';
import { GeneratorPool } from './gen-pool.js';
import { Orchestrator } from './orchestrator.js';
import { startGenWsServer } from './gen-ws/server.js';
import { startRestServer } from './rest/server.js';
import { startBrowserWsServer } from './browser-ws/server.js';

export async function startController(): Promise<void> {
  const pool = new GeneratorPool();
  const clickhouse = getClickHouse();
  const testsDao = new TestsDao();

  const orch = new Orchestrator(pool, {
    clickhouse,
    writeColdPath: true,
    testsDao,
  });

  await startGenWsServer(pool, orch, { port: env.genPort });
  const rest = await startRestServer(pool, orch, {
    port: env.publicPort,
    testsDao,
    clickhouse,
  });
  // Socket.IO piggybacks on the REST HTTP server so browsers only need one
  // public port. io.attach() hooks into the 'upgrade' event without racing
  // Express's middleware chain.
  startBrowserWsServer(rest.httpServer, orch);

  logger.info(
    { publicPort: env.publicPort, genPort: env.genPort },
    'Controller up (REST + browser WS on publicPort, generator WS on genPort/gen)',
  );
}
