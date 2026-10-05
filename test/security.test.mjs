import assert from 'node:assert/strict';
import test from 'node:test';

import worker, * as workerModule from '../src/index.ts';

const { purchaseAuditMessage } = workerModule;

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values) {
    this.db.bindings.push({ sql: this.sql, values });
    return this;
  }

  async all() {
    return { results: [] };
  }

  async first() {
    return null;
  }

  async run() {
    this.db.runs.push(this.sql);
    return { success: true };
  }
}

class FakeD1 {
  constructor() {
    this.prepared = [];
    this.bindings = [];
    this.runs = [];
  }

  prepare(sql) {
    this.prepared.push(sql);
    return new FakeStatement(this, sql);
  }
}

function env(db) {
  return {
    DB: db,
    STRIPE_SECRET_KEY: 'test-only-placeholder',
    STRIPE_WEBHOOK_SECRET: 'test-only-placeholder',
    FRONTEND_URL: 'https://example.test'
  };
}

test('POST /agent rejects a missing API key before any D1 mutation', async () => {
  const db = new FakeD1();
  const response = await worker.fetch(
    new Request('https://worker.test/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'add user-1 Example User' })
    }),
    env(db)
  );

  assert.equal(response.status, 401);
  assert.equal(db.runs.length, 0);
});

test('POST /agent binds an API key instead of interpolating it into SQL', async () => {
  const db = new FakeD1();
  const suppliedKey = "candidate' OR 1=1 --";
  const response = await worker.fetch(
    new Request('https://worker.test/agent', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': suppliedKey
      },
      body: JSON.stringify({ message: 'get user-1' })
    }),
    env(db)
  );

  assert.equal(response.status, 401);
  assert.equal(db.prepared.some((sql) => sql.includes(suppliedKey)), false);
  assert.equal(
    db.bindings.some(({ values }) => values.length === 1 && values[0] === suppliedKey),
    true
  );
});

test('purchase audit output excludes customer and credential material', () => {
  assert.equal(typeof purchaseAuditMessage, 'function');
  const message = purchaseAuditMessage('customer@example.test', 'sk_sensitive_example');

  assert.equal(message, 'Purchase recorded for verified checkout session');
  assert.equal(message.includes('customer@example.test'), false);
  assert.equal(message.includes('sk_sensitive_example'), false);
});
