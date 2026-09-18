import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Command, SignedMessage } from '../../packages/contracts/index.js';
import { signMessage, fingerprint } from '../../packages/security/index.js';
export class SimulatorStore {
  db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS inbox(command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL,effect_count INTEGER NOT NULL,receipt TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0);',
    );
  }
  process(
    command: Command,
    key: string,
    version: number,
    beforeCommit?: () => void,
  ): SignedMessage {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db
        .prepare('SELECT * FROM inbox WHERE command_id=?')
        .get(command.commandId);
      if (previous) {
        if (previous.fingerprint !== fingerprint(command))
          throw new Error('conflicting_command');
        this.db
          .prepare('UPDATE inbox SET acknowledged=0 WHERE command_id=?')
          .run(command.commandId);
        this.db.exec('COMMIT');
        return JSON.parse(String(previous.receipt)) as SignedMessage;
      }
      const result: 'expired' | 'completed' =
        Date.now() > new Date(command.expiresAt).getTime()
          ? 'expired'
          : 'completed';
      const unsigned = {
        kind: 'receipt' as const,
        deviceId: command.deviceId,
        credentialVersion: version,
        messageId: randomUUID(),
        timestamp: new Date().toISOString(),
        commandId: command.commandId,
        result,
      };
      const receipt = { ...unsigned, signature: signMessage(unsigned, key) };
      this.db
        .prepare(
          'INSERT INTO inbox(command_id,fingerprint,result,effect_count,receipt) VALUES(?,?,?,?,?)',
        )
        .run(
          command.commandId,
          fingerprint(command),
          result,
          result === 'completed' ? 1 : 0,
          JSON.stringify(receipt),
        );
      beforeCommit?.();
      this.db.exec('COMMIT');
      return receipt;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  pending() {
    return this.db
      .prepare('SELECT receipt FROM inbox WHERE acknowledged=0 LIMIT 20')
      .all()
      .map((r) => JSON.parse(String(r.receipt)) as SignedMessage);
  }
  acknowledge(commandId: string) {
    this.db
      .prepare('UPDATE inbox SET acknowledged=1 WHERE command_id=?')
      .run(commandId);
  }
  close() {
    this.db.close();
  }
}
