import Stripe from 'stripe';

interface Env {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  FRONTEND_URL: string;
}

interface State {
  userId?: string;
  tier?: string;
}

class MyAgent {
  env: Env;
  state: State;

  constructor(env: Env, state: State = {}) {
    this.env = env;
    this.state = state;
  }

  async sql<T = any>(strings: TemplateStringsArray, ...values: any[]): Promise<T[]> {
    let query = strings[0];
    for (let i = 0; i < values.length; i++) {
      query += `${this.escapeValue(values[i])}${strings[i + 1]}`;
    }
    const stmt = this.env.DB.prepare(query);
    const result = await stmt.all<T>();
    return (result.results as T[]) || [];
  }

  private escapeValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '0';
    return `'${JSON.stringify(value).replace(/'/g, "''')}'`;
  }

  async init() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        referrer TEXT,
        meta TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stripe_session_id TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL,
        amount INTEGER NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS api_keys (
        api_key TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`
    ];

    for (const table of tables) {
      try {
        await this.env.DB.prepare(table).run();
      } catch (err) {
        console.error('Table creation error:', err);
      }
    }
  }

  async addUser(id: string, name: string) {
    try {
      await this.env.DB.prepare(
        'INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, datetime(\'now\'))'
      ).bind(id, name).run();
      return { ok: true, id, name };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async getUser(id: string) {
    const rows = await this.sql<{ id: string; name: string; email?: string }>(
      `SELECT * FROM users WHERE id = '${id}'`
    );
    return rows[0] ?? null;
  }

  async track(type: string, meta: any = {}) {
    try {
      await this.env.DB.prepare(
        'INSERT INTO events (type, referrer, meta, created_at) VALUES (?, ?, ?, datetime(\'now\'))'
      )
        .bind(type, meta.referrer ?? null, JSON.stringify(meta))
        .run();
      return { ok: true };
    } catch (err: any) {
      return { error: err.message };
    }
  }

  async checkKey(apiKey: string) {
    const rows = await this.sql<{ api_key: string; tier: string; email: string }>(
      `SELECT api_key, tier, email FROM api_keys WHERE api_key = '${apiKey}'`
    );
    if (!rows.length) return null;
    this.state.tier = rows[0].tier;
    return rows[0];
  }

  async onMessage(message: string) {
    if (message.startsWith('add ')) {
      const [, id, ...rest] = message.split(' ');
      const name = rest.join(' ');
      return this.addUser(id, name);
    }

    if (message.startsWith('get ')) {
      const [, id] = message.split(' ');
      return this.getUser(id);
    }

    if (message.startsWith('track ')) {
      const [, type] = message.split(' ');
      return this.track(type);
    }

    return { error: 'Unknown command. Try: add <id> <name>, get <id>, or track <type>' };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Stripe-Signature,x-api-key'
  };
}

function cors(): Response {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

async function withCors(res: Response | Promise<Response>): Promise<Response> {
  const r = await res;
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
  return new Response(r.body, { status: r.status, headers });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors();
    }

    // Agent endpoint (optional API key check via header)
    if (url.pathname === '/agent' && request.method === 'POST') {
      const body = await request.json().catch(() => ({} as any));
      const message = body.message ?? '';
      const apiKey = request.headers.get('x-api-key') ?? body.apiKey ?? null;

      const agent = new MyAgent(env, {});
      await agent.init();

      if (apiKey) {
        const keyRow = await agent.checkKey(apiKey);
        if (!keyRow) return withCors(json({ error: 'invalid_api_key' }, 401));
      }

      const result = await agent.onMessage(message);
      return withCors(json(result));
    }

    // Event tracking
    if (url.pathname === '/event' && request.method === 'POST') {
      const body = await request.json().catch(() => ({} as any));
      const agent = new MyAgent(env, {});
      await agent.init();
      const result = await agent.track(body.type ?? 'unknown', body);
      return withCors(json(result));
    }

    // Metrics
    if (url.pathname === '/metrics' && request.method === 'GET') {
      try {
        const revenue = await env.DB.prepare(
          `SELECT COALESCE(SUM(amount),0) AS total
           FROM purchases
           WHERE created_at >= datetime('now', '-1 day')`
        ).first<{ total: number }>();

        const visitors = await env.DB.prepare(
          `SELECT COUNT(*) AS total
           FROM events
           WHERE type='page_view'
             AND created_at >= datetime('now', '-1 day')`
        ).first<{ total: number }>();

        const clicks = await env.DB.prepare(
          `SELECT COUNT(*) AS total
           FROM events
           WHERE type='cta_click'
             AND created_at >= datetime('now', '-1 day')`
        ).first<{ total: number }>();

        const v = visitors?.total ?? 0;
        const c = clicks?.total ?? 0;
        const r = revenue?.total ?? 0;

        return withCors(
          json({
            revenue_24h: r / 100,
            visitors_24h: v,
            conversion_rate: v > 0 ? (c / v).toFixed(2) : 0,
            projected_value: ((r / 100) * 30).toFixed(2),
            cta_clicks_24h: c
          })
        );
      } catch (err: any) {
        return withCors(json({ error: err.message }, 500));
      }
    }

    // Stripe checkout
    if (url.pathname === '/checkout' && request.method === 'POST') {
      try {
        const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' as any });
        const body = await request.json().catch(() => ({} as any));
        const tier = body.tier ?? 'prime';

        const priceMap: Record<string, number> = {
          base: 10000, // $100
          sovereign: 25000, // $250
          prime: 50000 // $500
        };

        const amount = priceMap[tier] ?? priceMap['prime'];
        const tierNames: Record<string, string> = {
          base: 'BASE',
          sovereign: 'SOVEREIGN',
          prime: 'PRIME'
        };

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          payment_method_types: ['card'],
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: 'usd',
                unit_amount: amount,
                product_data: {
                  name: `Silent Life Intelligence — ${tierNames[tier]}`
                }
              }
            }
          ],
          success_url: `${env.FRONTEND_URL}/?success=1&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${env.FRONTEND_URL}/?canceled=1`,
          metadata: { tier }
        });

        return withCors(json({ url: session.url, session_id: session.id }));
      } catch (err: any) {
        return withCors(json({ error: err.message }, 400));
      }
    }

    // Stripe webhook
    if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
      try {
        const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' as any });
        const sig = request.headers.get('Stripe-Signature') || '';
        const rawBody = await request.text();

        let event: Stripe.Event;
        try {
          event = stripe.webhooks.constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
        } catch (err: any) {
          return new Response(`Webhook Error: ${err.message}`, { status: 400 });
        }

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object as Stripe.Checkout.Session;
          const tier = (session.metadata?.tier as string) ?? 'prime';
          const amount = session.amount_total ?? 0;
          const email = (session.customer_details?.email as string) ?? 'unknown';

          await env.DB.prepare(
            `INSERT INTO purchases (stripe_session_id, tier, amount, email, created_at)
             VALUES (?, ?, ?, ?, datetime('now'))`
          )
            .bind(session.id, tier, amount, email)
            .run();

          const apiKey =
            'sk_' +
            crypto.randomUUID().replace(/-/g, '').substring(0, 24);

          await env.DB.prepare(
            `INSERT INTO api_keys (api_key, tier, email, created_at)
             VALUES (?, ?, ?, datetime('now'))`
          )
            .bind(apiKey, tier, email)
            .run();

          console.log(`Purchase recorded: ${email} -> ${tier} (Key: ${apiKey})`);
          // TODO: Deliver apiKey via secure email/portal, not response
        }

        return new Response('OK', { status: 200 });
      } catch (err: any) {
        return new Response(`Error: ${err.message}`, { status: 500 });
      }
    }

    // Health check
    if (url.pathname === '/health' && request.method === 'GET') {
      return withCors(json({ status: 'ok', timestamp: new Date().toISOString() }));
    }

    return withCors(json({ error: 'Not found. Try /agent, /event, /checkout, /metrics, or /health' }, 404));
  }
} satisfies ExportedHandler<Env>;
