import React, { useCallback, useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
type Row = Record<string, unknown>;
type Merchant = { id: string; name: string; role: string };
const label = (v: unknown) => (v === null || v === undefined ? '—' : String(v));
const date = (v: unknown) =>
  v ? new Date(String(v)).toLocaleString() : 'Not received';
function App() {
  const [token, setToken] = useState(''),
    [email, setEmail] = useState('admin@cedar.test'),
    [password, setPassword] = useState(''),
    [merchants, setMerchants] = useState<Merchant[]>([]),
    [merchant, setMerchant] = useState(''),
    [tab, setTab] = useState('Overview'),
    [payments, setPayments] = useState<Row[]>([]),
    [devices, setDevices] = useState<Row[]>([]),
    [incidents, setIncidents] = useState<Row[]>([]),
    [audit, setAudit] = useState<Row[]>([]),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [detail, setDetail] = useState<Row | null>(null),
    [detailType, setDetailType] = useState(''),
    [updated, setUpdated] = useState(''),
    [page, setPage] = useState(0);
  const activeScope = useRef('');
  activeScope.current = `${token}:${merchant}:${page}`;
  const request = useCallback(
    async (path: string, body?: unknown) => {
      const r = await fetch('/api' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 401) setToken('');
        throw new Error(data.error ?? 'Request failed');
      }
      return data;
    },
    [token],
  );
  const refresh = useCallback(async () => {
    if (!merchant) return;
    const scope = activeScope.current;
    try {
      const prefix = `/merchants/${merchant}`;
      const [p, d, i, a] = await Promise.all(
        ['/payments', '/devices', '/incidents', '/audit'].map((path) =>
          request(prefix + path + `?limit=25&offset=${page * 25}`),
        ),
      );
      if (scope !== activeScope.current) return;
      setPayments(p);
      setDevices(d);
      setIncidents(i);
      setAudit(a);
      setError('');
      setUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      if (scope !== activeScope.current) return;
      setError((e as Error).message + ' · Retrying in 5 seconds');
    }
  }, [merchant, request, page]);
  useEffect(() => {
    setPayments([]);
    setDevices([]);
    setIncidents([]);
    setAudit([]);
    setDetail(null);
    setUpdated('');
    if (!token) {
      setMerchants([]);
      setMerchant('');
    }
    if (token) {
      void request('/me')
        .then((m: Merchant[]) => {
          setMerchants(m);
          setMerchant(m[0]?.id ?? '');
        })
        .catch((e) => setError(e.message));
    }
  }, [token, request]);
  useEffect(() => {
    if (!token) return;
    setPayments([]);
    setDevices([]);
    setIncidents([]);
    setAudit([]);
    setDetail(null);
    setLoading(true);
    void refresh().finally(() => setLoading(false));
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh, token]);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await request('/login', { email, password });
      setToken(result.token);
      setPassword('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  async function inspect(kind: string, id: unknown) {
    try {
      setDetail(await request(`/merchants/${merchant}/${kind}/${id}`));
      setDetailType(kind);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function replay(id: unknown) {
    if (
      !window.confirm(
        'Replay this synthetic announcement using the same logical command ID? This action will be audited.',
      )
    )
      return;
    try {
      await request(`/merchants/${merchant}/announcements/${id}/replay`, {
        confirm: true,
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const role = merchants.find((m) => m.id === merchant)?.role,
    failed = payments.filter((p) =>
      ['exhausted', 'permanent', 'expired'].includes(String(p.dispatch_status)),
    );
  if (!token)
    return (
      <main className="login">
        <section>
          <div className="logo">
            ◈ <span>payops</span>
          </div>
          <p className="eyebrow">RELIABLE BY DESIGN</p>
          <h1>
            Every payment.
            <br />
            Evidence you can trust.
          </h1>
          <p>
            Monitor synthetic soundbox delivery, follow incidents, and
            understand what happened.
          </p>
          <div className="login-flow">
            ACCEPTED <span>→</span> DISPATCHED <span>→</span> VERIFIED
          </div>
        </section>
        <form onSubmit={login}>
          <p className="eyebrow">OPERATIONS CONSOLE</p>
          <h2>Welcome back</h2>
          <p>Sign in to your merchant workspace.</p>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          <button disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in →'}
          </button>
          <small>
            Synthetic demonstration · No real money moves.
            <br />
            Use the SEED_PASSWORD from your local .env file.
          </small>
        </form>
      </main>
    );
  return (
    <div className="shell">
      <aside>
        <div className="logo">
          ◈ <span>payops</span>
        </div>
        <p className="eyebrow">WORKSPACE</p>
        <select
          aria-label="Merchant"
          value={merchant}
          onChange={(e) => {
            setMerchant(e.target.value);
            setDetail(null);
            setPage(0);
          }}
        >
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <nav>
          {[
            'Overview',
            'Payments',
            'Devices',
            'Incidents',
            'Failed announcements',
            'Audit history',
            'Investigation',
          ].map((t, i) => (
            <button
              key={t}
              className={tab === t ? 'active' : ''}
              onClick={() => {
                setTab(t);
                setPage(0);
                setDetail(null);
              }}
            >
              <span>{['▦', '↗', '▣', '◉', '↻', '≡', '✧'][i]}</span>
              {t}
              {t === 'Incidents' && <b>{incidents.length}</b>}
            </button>
          ))}
        </nav>
        <div className="aside-bottom">
          <span className="dot" /> Synthetic environment<p>{role}</p>
          <button
            onClick={() => {
              setToken('');
              setMerchant('');
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <header>
          <span>
            Operations <span className="slash">/</span> {tab}
          </span>
          <span className="pill">SANDBOX</span>
        </header>
        <section className="content">
          <div className="heading">
            <div>
              <p className="eyebrow">PAYMENT RELIABILITY</p>
              <h1>{tab}</h1>
              <p>Follow the evidence, from acceptance to device completion.</p>
            </div>
            <span className="updated">
              <span className="dot" />
              {updated ? `Updated ${updated}` : 'Connecting…'}
            </span>
          </div>
          {error && (
            <div role="alert" className="error">
              Connection issue: {error}
            </div>
          )}
          {loading && <p role="status">Loading your workspace…</p>}
          {tab === 'Overview' && (
            <>
              <div className="metrics">
                {[
                  ['Accepted', payments.length, 'payments on this page'],
                  [
                    'Device completed',
                    payments.filter((p) => p.state === 'completed').length,
                    'verified receipts',
                  ],
                  ['Needs attention', failed.length, 'terminal dispatches'],
                  [
                    'Open incidents',
                    incidents.filter((i) => i.status === 'open').length,
                    'evidence captured',
                  ],
                ].map(([title, note, sub]) => (
                  <article key={String(title)}>
                    <p>{title}</p>
                    <strong>{note}</strong>
                    <small>{sub}</small>
                  </article>
                ))}
              </div>
              <div className="notice">
                <span>◈</span>
                <div>
                  <b>Delivery is more than a broker acknowledgment.</b>
                  <p>
                    A payment is completed only when a valid device receipt is
                    durably stored.
                  </p>
                </div>
              </div>
            </>
          )}
          {['Overview', 'Payments', 'Failed announcements'].includes(tab) && (
            <article className="panel">
              <div className="panel-heading">
                <h2>
                  {tab === 'Failed announcements'
                    ? 'Failed announcements'
                    : 'Payment activity'}
                </h2>
                <span>Latest 25 · Synthetic payments</span>
              </div>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Payment / reference</th>
                      <th>Amount</th>
                      <th>Dispatch</th>
                      <th>Broker ACK</th>
                      <th>Device result</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(tab === 'Failed announcements' ? failed : payments).map(
                      (p) => (
                        <tr key={label(p.id)}>
                          <td>
                            <button
                              className="link"
                              onClick={() => void inspect('payments', p.id)}
                            >
                              {label(p.reference)}
                            </button>
                            <small>
                              {label(p.id).slice(0, 8)} · {date(p.accepted_at)}
                            </small>
                          </td>
                          <td>
                            {label(p.currency)}{' '}
                            {(Number(p.amount_minor) / 100).toFixed(2)}
                          </td>
                          <td>
                            <span className={'badge ' + p.dispatch_status}>
                              {label(p.dispatch_status)}
                            </span>
                          </td>
                          <td>
                            {p.published_at
                              ? 'Acknowledged'
                              : 'Awaiting broker'}
                          </td>
                          <td>
                            <span className={'badge ' + p.state}>
                              {label(p.state)}
                            </span>
                          </td>
                          <td>
                            {role !== 'reader' &&
                              ['exhausted', 'permanent', 'published'].includes(
                                String(p.dispatch_status),
                              ) &&
                              p.state !== 'completed' && (
                                <button
                                  className="secondary"
                                  onClick={() => void replay(p.command_id)}
                                >
                                  Replay
                                </button>
                              )}
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
                {!(tab === 'Failed announcements' ? failed : payments)
                  .length && (
                  <div className="empty">
                    No payments to show. Submit a synthetic payment using the
                    documented API or demo command.
                  </div>
                )}
              </div>
            </article>
          )}
          {tab === 'Devices' && (
            <div className="device-grid">
              {devices.map((d) => (
                <article className="panel device" key={label(d.id)}>
                  <div className="device-icon">▣</div>
                  <h2>{label(d.name)}</h2>
                  <span
                    className={
                      'badge ' +
                      (d.last_heartbeat &&
                      Date.now() -
                        new Date(String(d.last_heartbeat)).getTime() <
                        30000
                        ? 'completed'
                        : 'expired')
                    }
                  >
                    {d.revoked
                      ? 'Revoked'
                      : d.last_heartbeat &&
                          Date.now() -
                            new Date(String(d.last_heartbeat)).getTime() <
                            30000
                        ? 'Online'
                        : 'Offline / unknown'}
                  </span>
                  <p>
                    Last signed heartbeat
                    <br />
                    <b>{date(d.last_heartbeat)}</b>
                  </p>
                  <small>{label(d.id)}</small>
                </article>
              ))}
              {!devices.length && <p>No devices on this page.</p>}
            </div>
          )}
          {tab === 'Incidents' && (
            <article className="panel">
              <div className="panel-heading">
                <h2>Incident feed</h2>
                <span>Durable evidence snapshots</span>
              </div>
              {incidents.map((i) => (
                <button
                  key={label(i.id)}
                  className="incident"
                  onClick={() => void inspect('incidents', i.id)}
                >
                  <span className="incident-icon">!</span>
                  <div>
                    <b>{label(i.kind).replaceAll('_', ' ')}</b>
                    <small>
                      {date(i.opened_at)} · {label(i.resource_id).slice(0, 8)}
                    </small>
                  </div>
                  <span className="badge pending">{label(i.status)}</span>
                  <span>→</span>
                </button>
              ))}
              {!incidents.length && (
                <div className="empty">No incidents on this page.</div>
              )}
            </article>
          )}
          {tab === 'Audit history' && (
            <article className="panel">
              <h2>Operator audit history</h2>
              {audit.map((a) => (
                <p key={label(a.id)}>
                  {date(a.created_at)} · <b>{label(a.action)}</b> ·{' '}
                  {label(a.resource_id)}
                </p>
              ))}
              {!audit.length && <p>No recorded actions on this page.</p>}
            </article>
          )}
          {tab === 'Investigation' && (
            <article className="panel">
              <p className="eyebrow">READ-ONLY ASSISTANT</p>
              <h2>Investigation is gated on reliability verification</h2>
              <p>
                The assistant will be enabled after the real PostgreSQL and MQTT
                reliability suite passes. Incident evidence remains available in
                the Incidents view.
              </p>
            </article>
          )}
          {tab !== 'Investigation' && (
            <div className="pagination">
              <button
                className="secondary"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                ← Previous
              </button>
              <span>Page {page + 1}</span>
              <button className="secondary" onClick={() => setPage(page + 1)}>
                Next →
              </button>
            </div>
          )}
          {detail && (
            <article className="panel evidence">
              <div className="panel-heading">
                <h2>
                  {detailType === 'payments'
                    ? 'Delivery timeline'
                    : 'Incident evidence'}
                </h2>
                <button className="secondary" onClick={() => setDetail(null)}>
                  Close
                </button>
              </div>
              {detailType === 'payments' && (
                <div className="timeline">
                  <p>
                    ● Accepted <b>{date(detail.accepted_at)}</b>
                  </p>
                  <p>
                    ● Broker acknowledgment <b>{date(detail.published_at)}</b>
                  </p>
                  <p>
                    ● Verified completion <b>{date(detail.completed_at)}</b>
                  </p>
                </div>
              )}
              <pre>{JSON.stringify(detail, null, 2)}</pre>
            </article>
          )}
          <footer>
            PayOps GenAI <span>Durable intent. Verifiable outcomes.</span>
          </footer>
        </section>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
