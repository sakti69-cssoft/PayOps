import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Pool } from '../../packages/database/index.js';
import type { Config } from '../../packages/config.js';
import { evidenceMessage, type Role } from '../../packages/contracts/index.js';
import {
  checkPassword,
  issueToken,
  verifyToken,
} from '../../packages/security/index.js';
import { log } from '../../packages/observability/index.js';
import {
  acceptPayment,
  HttpError,
  receiveEvidence,
  replay,
} from './service.js';
export function createApp(pool: Pool, config: Config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((_req, res, next) => {
    res.locals.correlationId = randomUUID();
    res.setHeader('X-Request-ID', res.locals.correlationId);
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({
          error: 'Rate limit exceeded',
          correlationId: res.locals.correlationId,
        }),
    }),
  );
  app.get('/health/live', (_req, res) => res.json({ alive: true }));
  app.get('/health/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      const workers = await pool.query(
        "SELECT count(*)::int AS n FROM worker_status WHERE progressed_at > now()-interval '30 seconds'",
      );
      res
        .status(workers.rows[0].n ? 200 : 503)
        .json({ database: true, worker: workers.rows[0].n > 0 });
    } catch {
      res.status(503).json({ database: false });
    }
  });
  app.post(
    '/api/login',
    rateLimit({
      windowMs: 60000,
      limit: 10,
      handler: (_req, res) =>
        res.status(429).json({
          error: 'Rate limit exceeded',
          correlationId: res.locals.correlationId,
        }),
    }),
    async (req, res) => {
      const { email, password } = z
        .object({ email: z.email(), password: z.string().min(1).max(128) })
        .parse(req.body);
      const user = await pool.query('SELECT * FROM users WHERE email=$1', [
        email.toLowerCase(),
      ]);
      if (
        !user.rowCount ||
        !(await checkPassword(password, user.rows[0].password_hash))
      ) {
        await pool.query(
          "INSERT INTO audit_events(action) VALUES('auth.failure')",
        );
        throw new HttpError(401, 'Invalid login');
      }
      const token = await issueToken(user.rows[0].id, config.JWT_SECRET);
      res.json({ token });
    },
  );
  app.post('/api/device-evidence', async (req, res) => {
    try {
      res.json(await receiveEvidence(pool, evidenceMessage.parse(req.body)));
    } catch (e) {
      if (e instanceof HttpError && e.status === 401)
        await pool.query(
          "INSERT INTO audit_events(merchant_id,action,resource_id) SELECT merchant_id,'device.auth.failure',id FROM devices WHERE id=$1",
          [
            z.uuid().safeParse(req.body?.deviceId).success
              ? req.body.deviceId
              : null,
          ],
        );
      throw e;
    }
  });
  app.use('/api', async (req, res, next) => {
    try {
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!token) throw new Error('Missing token');
      res.locals.userId = await verifyToken(token, config.JWT_SECRET);
      next();
    } catch {
      next(new HttpError(401, 'Authentication required'));
    }
  });
  app.get('/api/me', async (_req, res) => {
    res.json(
      (
        await pool.query(
          'SELECT m.id,m.name,ms.role FROM memberships ms JOIN merchants m ON m.id=ms.merchant_id WHERE ms.user_id=$1',
          [res.locals.userId],
        )
      ).rows,
    );
  });
  app.use('/api/merchants/:merchantId', async (req, res, next) => {
    const merchantId = z.uuid().parse(req.params.merchantId);
    const membership = await pool.query(
      'SELECT role FROM memberships WHERE merchant_id=$1 AND user_id=$2',
      [merchantId, res.locals.userId],
    );
    if (!membership.rowCount) throw new HttpError(404, 'Merchant not found');
    res.locals.merchantId = merchantId;
    res.locals.role = membership.rows[0].role;
    next();
  });
  const base = '/api/merchants/:merchantId';
  const operator = (_req: Request, res: Response, next: NextFunction) => {
    if (!['operator', 'merchant-admin'].includes(res.locals.role as Role))
      throw new HttpError(403, 'Operator permission required');
    next();
  };
  const page = (req: Request) => ({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(25)
      .parse(req.query.limit),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .default(0)
      .parse(req.query.offset),
  });
  app.post(base + '/payments', operator, async (req, res) => {
    const key = z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w:.-]+$/)
      .parse(req.headers['idempotency-key']);
    const result = await acceptPayment(
      pool,
      config,
      res.locals.merchantId,
      key,
      req.body,
    );
    res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.get(base + '/payments', async (req, res) => {
    const p = page(req);
    res.json(
      (
        await pool.query(
          'SELECT p.id,p.amount_minor,p.currency,p.reference,p.accepted_at,c.id AS command_id,c.state,c.published_at,c.completed_at,o.status AS dispatch_status FROM payments p JOIN commands c ON c.payment_id=p.id JOIN outbox o ON o.command_id=c.id WHERE p.merchant_id=$1 ORDER BY p.accepted_at DESC LIMIT $2 OFFSET $3',
          [res.locals.merchantId, p.limit, p.offset],
        )
      ).rows,
    );
  });
  app.get(base + '/payments/:id', async (req, res) => {
    const row = await pool.query(
      'SELECT p.*,c.id AS command_id,c.state,c.published_at,c.completed_at FROM payments p JOIN commands c ON c.payment_id=p.id WHERE p.id=$1 AND p.merchant_id=$2',
      [z.uuid().parse(req.params.id), res.locals.merchantId],
    );
    if (!row.rowCount) throw new HttpError(404, 'Payment not found');
    const command = row.rows[0].command_id;
    const attempts = await pool.query(
      'SELECT a.* FROM delivery_attempts a JOIN outbox o ON o.id=a.outbox_id WHERE o.command_id=$1 ORDER BY a.id LIMIT 100',
      [command],
    );
    const receipts = await pool.query(
      'SELECT id,result,conflicting,received_at,device_timestamp FROM receipts WHERE command_id=$1 ORDER BY received_at LIMIT 100',
      [command],
    );
    res.json({
      ...row.rows[0],
      attempts: attempts.rows,
      receipts: receipts.rows,
    });
  });
  app.get(base + '/devices', async (req, res) => {
    const p = page(req);
    res.json(
      (
        await pool.query(
          'SELECT id,name,last_heartbeat,revoked FROM devices WHERE merchant_id=$1 ORDER BY name LIMIT $2 OFFSET $3',
          [res.locals.merchantId, p.limit, p.offset],
        )
      ).rows,
    );
  });
  app.get(base + '/devices/:id', async (req, res) => {
    const row = await pool.query(
      'SELECT id,name,last_heartbeat,revoked FROM devices WHERE id=$1 AND merchant_id=$2',
      [z.uuid().parse(req.params.id), res.locals.merchantId],
    );
    if (!row.rowCount) throw new HttpError(404, 'Device not found');
    res.json(row.rows[0]);
  });
  app.get(base + '/incidents', async (req, res) => {
    const p = page(req);
    res.json(
      (
        await pool.query(
          'SELECT * FROM incidents WHERE merchant_id=$1 ORDER BY opened_at DESC LIMIT $2 OFFSET $3',
          [res.locals.merchantId, p.limit, p.offset],
        )
      ).rows,
    );
  });
  app.get(base + '/incidents/:id', async (req, res) => {
    const row = await pool.query(
      'SELECT * FROM incidents WHERE id=$1 AND merchant_id=$2',
      [z.uuid().parse(req.params.id), res.locals.merchantId],
    );
    if (!row.rowCount) throw new HttpError(404, 'Incident not found');
    const evidence = await pool.query(
      'SELECT * FROM incident_evidence WHERE incident_id=$1 ORDER BY captured_at LIMIT 50',
      [req.params.id],
    );
    res.json({ ...row.rows[0], evidence: evidence.rows });
  });
  app.post(base + '/announcements/:id/replay', operator, async (req, res) => {
    z.object({ confirm: z.literal(true) }).parse(req.body);
    res.json(
      await replay(
        pool,
        res.locals.merchantId,
        res.locals.userId,
        z.uuid().parse(req.params.id),
      ),
    );
  });
  app.get(base + '/audit', async (req, res) => {
    const p = page(req);
    res.json(
      (
        await pool.query(
          'SELECT id,action,resource_id,created_at FROM audit_events WHERE merchant_id=$1 ORDER BY id DESC LIMIT $2 OFFSET $3',
          [res.locals.merchantId, p.limit, p.offset],
        )
      ).rows,
    );
  });
  app.use((_req, res) =>
    res
      .status(404)
      .json({ error: 'Not found', correlationId: res.locals.correlationId }),
  );
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      err instanceof HttpError
        ? err.status
        : err instanceof ZodError
          ? 400
          : typeof err === 'object' && err !== null && 'status' in err
            ? Number(err.status)
            : 500;
    if (status >= 500)
      log.error({
        event: 'request.failure',
        correlationId: res.locals.correlationId,
        error: err instanceof Error ? err.name : 'Unknown',
      });
    res.status(status).json({
      error:
        status >= 500
          ? 'Service unavailable'
          : err instanceof Error
            ? err.message
            : 'Invalid request',
      correlationId: res.locals.correlationId,
    });
  });
  return app;
}
