import { logger } from '../logger.js';
import { env } from '../env.js';

export async function startController(): Promise<void> {
  logger.info(
    { publicPort: env.publicPort, genPort: env.genPort },
    'Controller skeleton (Session 5 wires up listeners)',
  );
}
