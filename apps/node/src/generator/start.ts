import { logger } from '../logger.js';
import { env } from '../env.js';

export async function startGenerator(): Promise<void> {
  logger.info(
    { controllerUrl: env.controllerUrl },
    'Generator skeleton (Session 2 wires up the VU pool)',
  );
}
