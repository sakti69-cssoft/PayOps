import { expect, it } from 'vitest';
import { run } from '../../scripts/process.js';

it('bounds subprocess execution and reports failures', async () => {
  await expect(
    run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      timeout: 300,
      quiet: true,
    }),
  ).rejects.toThrow('timed out');
  await expect(
    run(process.execPath, ['-e', 'process.exit(7)'], {
      quiet: true,
    }),
  ).rejects.toThrow('exited 7');
  expect(
    await run(process.execPath, ['-e', 'process.stdout.write("ready")'], {
      quiet: true,
    }),
  ).toBe('ready');
}, 15000);
