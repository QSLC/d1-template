import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import worker, * as workerModule from '../src/index.ts';

const { purchaseAuditMessage, claimCredentialForCheckout } = workerModule;

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

test('POST /agent hashes an API key before querying D1', async () => {
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
    db.bindings.some(({ values }) => values.includes(suppliedKey)),
    false,
    'the raw credential must not be sent to D1'
  );
  assert.equal(
    db.bindings.some(({ values }) =>
      values.some((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    ),
    true,
    'the lookup should bind a SHA-256 hash'
  );
});

test('purchase audit output excludes customer and credential material', () => {
  assert.equal(typeof purchaseAuditMessage, 'function');
  const message = purchaseAuditMessage('customer@example.test', 'sk_sensitive_example');

  assert.equal(message, 'Purchase recorded for verified checkout session');
  assert.equal(message.includes('customer@example.test'), false);
  assert.equal(message.includes('sk_sensitive_example'), false);
});

test('paid checkout credentials have a supported one-time claim function', () => {
  assert.equal(typeof claimCredentialForCheckout, 'function');
});

test('paid completed checkout returns a credential while persisting only its hash', async () => {
  const db = new FakeD1();
  const claimToken = 'claim-token-known-only-to-the-checkout-client';
  const claimTokenHash = createHash('sha256').update(claimToken).digest('hex');
  const result = await claimCredentialForCheckout(env(db), {
    id: 'cs_paid_example',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 10000,
    metadata: { tier: 'base', credential_claim_hash: claimTokenHash },
    customer_details: { email: 'customer@example.test' }
  }, claimToken);

  assert.equal(result.status, 200);
  assert.match(result.apiKey, /^qslc_[a-f0-9]{48}$/);
  assert.equal(
    db.bindings.some(({ values }) => values.includes(result.apiKey)),
    false,
    'the raw credential must never be stored in D1'
  );
  assert.equal(
    db.bindings.some(({ values }) =>
      values.some((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
    ),
    true,
    'a SHA-256 credential hash should be stored'
  );
});

test('paid checkout rejects a caller without the original claim token', async () => {
  const db = new FakeD1();
  const result = await claimCredentialForCheckout(env(db), {
    id: 'cs_paid_example',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 10000,
    metadata: {
      tier: 'base',
      credential_claim_hash: createHash('sha256').update('correct-token').digest('hex')
    },
    customer_details: { email: 'customer@example.test' }
  }, 'wrong-token');

  assert.deepEqual(result, { status: 403, error: 'claim_token_invalid' });
  assert.equal(db.runs.length, 0);
});

test('unpaid checkout cannot claim a credential or mutate D1', async () => {
  const db = new FakeD1();
  const result = await claimCredentialForCheckout(env(db), {
    id: 'cs_unpaid_example',
    status: 'open',
    payment_status: 'unpaid',
    amount_total: 10000,
    metadata: { tier: 'base' },
    customer_details: { email: 'customer@example.test' }
  });

  assert.deepEqual(result, { status: 403, error: 'paid_checkout_required' });
  assert.equal(db.runs.length, 0);
});
