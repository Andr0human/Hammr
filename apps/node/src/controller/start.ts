import { logger } from '../logger.js';
import { env } from '../env.js';
import { getClickHouse } from '../db/clickhouse.js';
import { GeneratorPool } from './gen-pool.js';
import { Orchestrator } from './orchestrator.js';
import { startGenWsServer } from './gen-ws/server.js';
import { startRestServer } from './rest/server.js';

export async function startController(): Promise<void> {
  const pool = new GeneratorPool();
  const orch = new Orchestrator(pool, {
    clickhouse: getClickHouse(),
    writeColdPath: true,
  });

  await startGenWsServer(pool, orch, { port: env.genPort });
  await startRestServer(pool, orch, { port: env.publicPort });

  logger.info(
    { publicPort: env.publicPort, genPort: env.genPort },
    'Controller up (REST on publicPort, generator WS on genPort/gen)',
  );
}
