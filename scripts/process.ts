import { spawn, spawnSync } from 'node:child_process';
export async function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeout?: number; quiet?: boolean } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 10000,
        });
      } else child.kill();
      reject(new Error(`${command} timed out`));
    }, options.timeout ?? 120000);
    child.stdout.on('data', (b) => {
      output += String(b);
      if (!options.quiet) process.stdout.write(b);
    });
    child.stderr.on('data', (b) => {
      output += String(b);
      if (!options.quiet) process.stderr.write(b);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}
export async function until(check: () => Promise<boolean>, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check().catch(() => false)) return Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Condition not reached within ${timeout}ms`);
}
