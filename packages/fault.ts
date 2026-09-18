import type { Config } from './config.js';
import { writeSync } from 'node:fs';
export function fault(config: Config, point: string) {
  if (config.FAULT_TEST === '1' && config.FAULT_POINT === point) {
    writeSync(2, JSON.stringify({ event: 'fault.injected', point }) + '\n');
    process.exit(86);
  }
}
