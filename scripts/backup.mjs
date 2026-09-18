import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
const project = process.env.COMPOSE_PROJECT_NAME ?? 'payops';
if (!/^payops(?:-[a-z0-9-]+)?$/.test(project))
  throw new Error('Invalid project');
mkdirSync('backups', { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-');
const path = `backups/payops-${stamp}.dump`;
const output = createWriteStream(path, { flags: 'wx' });
const child = spawn(
  'docker',
  [
    'compose',
    '-p',
    project,
    'exec',
    '-T',
    'database',
    'pg_dump',
    '-U',
    'payops',
    '-d',
    'payops',
    '-Fc',
    '--no-owner',
    '--no-acl',
  ],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] },
);
child.stdout.pipe(output);
try {
  const [[code]] = await Promise.all([once(child, 'exit'), finished(output)]);
  if (code !== 0) {
    process.exitCode = 1;
    console.error('Backup failed; do not use incomplete dump.');
    throw new Error('Backup process failed');
  }
  writeFileSync(
    `${path}.json`,
    JSON.stringify(
      {
        completedAt: new Date().toISOString(),
        startedAt: stamp,
        database: 'payops',
        pointInTimeRecovery: false,
      },
      null,
      2,
    ),
  );
  console.log(`Backup: ${path}`);
} catch (error) {
  output.destroy();
  process.exitCode = 1;
  console.error(error.message);
}
