import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
const path = process.argv[2];
if (!path || !existsSync(path))
  throw new Error('Usage: node scripts/restore.mjs backups/<file>.dump');
const project = process.env.COMPOSE_PROJECT_NAME ?? 'payops';
if (!/^payops(?:-[a-z0-9-]+)?$/.test(project))
  throw new Error('Invalid project');
const db = `payops_restore_${Date.now()}`;
const base = ['compose', '-p', project, 'exec', '-T', 'database'];
const created = spawnSync('docker', [...base, 'createdb', '-U', 'payops', db], {
  stdio: 'inherit',
  windowsHide: true,
});
if (created.status !== 0)
  throw new Error('Could not create separate restore database');
const child = spawn(
  'docker',
  [
    ...base,
    'pg_restore',
    '-U',
    'payops',
    '-d',
    db,
    '--no-owner',
    '--no-acl',
    '--exit-on-error',
  ],
  { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true },
);
createReadStream(path).pipe(child.stdin);
child.on('exit', (code) => {
  if (code !== 0) {
    process.exitCode = 1;
    console.error(`Restore failed in ${db}; retained for inspection.`);
  } else
    console.log(
      `Restored into separate database ${db}; inspect counts and evidence before switching any application.`,
    );
});
