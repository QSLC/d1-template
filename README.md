# Production-Grade Cloudflare Worker + D1 + Stripe

Full-stack backend with:
- **Agent**: Stateful, DB-backed command processing
- **D1 Database**: Users, events, purchases, API keys
- **Stripe Integration**: Checkout & webhooks
- **API Tiers**: Base, Sovereign, Prime with rate limiting via keys
- **Metrics**: Revenue, visitors, conversion, projected value (24h)
- **Events**: Automatic tracking (page views, CTAs, etc.)
- **CORS**: Enabled for frontend integration

## Setup

### 1. Install Dependencies
```bash
pnpm install
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` (local) or `.env.production` (for `wrangler deploy --env production`):

```bash
cp .env.example .env
```

Fill in your **Stripe secret key** and **webhook secret** (from https://dashboard.stripe.com).

### 3. Create D1 Database (if not exists)
```bash
wrangler d1 create d1-template-database
```

Update the `database_id` in `wrangler.json` with the ID from the output.

### 4. Apply Migrations
```bash
# Local development
pnpm run seedLocalD1

# Remote (staging/production)
wrangler d1 migrations apply DB --remote --env staging
wrangler d1 migrations apply DB --remote --env production
```

### 5. Develop Locally
```bash
pnpm run dev
```

Worker runs on `http://localhost:8787`.

### 6. Deploy
```bash
# Staging
wrangler deploy --env staging

# Production
wrangler deploy --env production
```

## API Endpoints

### POST `/agent`
Stateful agent for database commands.

**Request:**
```json
{
  "message": "add user123 John Doe",
  "apiKey": "sk_abc..."
}
```

**Commands:**
- `add <id> <name>` — Create user
- `get <id>` — Fetch user
- `track <type>` — Log event

**Response:**
```json
{
  "ok": true,
  "id": "user123",
  "name": "John Doe"
}
```

---

### POST `/event`
Track events (page view, CTA click, etc.).

**Request:**
```json
{
  "type": "page_view",
  "referrer": "https://google.com",
  "userId": "user123"
}
```

**Response:**
```json
{
  "ok": true
}
```

---

### POST `/checkout`
Create Stripe checkout session.

**Request:**
```json
{
  "tier": "prime"
}
```

**Response:**
```json
{
  "url": "https://checkout.stripe.com/pay/cs_...",
  "session_id": "cs_..."
}
```

**Tiers:**
- `base` — $100 (10,000 cents)
- `sovereign` — $250 (25,000 cents)
- `prime` — $500 (50,000 cents)

---

### POST `/stripe-webhook`
Webhook for Stripe events (checkout.session.completed).

**Setup:**
1. Go to https://dashboard.stripe.com/webhooks
2. Create endpoint: `https://your-worker.workers.dev/stripe-webhook`
3. Listen to: `checkout.session.completed`
4. Copy signing secret → `.env` as `STRIPE_WEBHOOK_SECRET`

**On purchase:**
- Record to `purchases` table
- Generate API key → `api_keys` table
- Key format: `sk_` + 24 random chars
- **TODO:** Deliver key via email/portal (not in response for security)

---

### GET `/metrics`
24-hour metrics: revenue, visitors, conversion, projection.

**Response:**
```json
{
  "revenue_24h": 1250.50,
  "visitors_24h": 342,
  "conversion_rate": "0.15",
  "cta_clicks_24h": 51,
  "projected_value": "37515.00"
}
```

---

### GET `/health`
Health check.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-06-14T12:00:00Z"
}
```

---

## API Key Authentication

Optional on `/agent` endpoint via header:
```bash
curl -H "x-api-key: sk_abc..." https://your-worker.workers.dev/agent
```

**Tiers control rate limits & features** (implement in frontend dashboard).

---

## Database Schema

### users
```sql
id TEXT PRIMARY KEY
name TEXT NOT NULL
email TEXT UNIQUE
created_at TEXT
```

### events
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
type TEXT NOT NULL (page_view, cta_click, purchase, etc.)
referrer TEXT
meta TEXT (JSON)
created_at TEXT
```

### purchases
```sql
id INTEGER PRIMARY KEY AUTOINCREMENT
stripe_session_id TEXT UNIQUE
tier TEXT (base, sovereign, prime)
amount INTEGER (cents)
email TEXT
created_at TEXT
```

### api_keys
```sql
api_key TEXT PRIMARY KEY (sk_...)
tier TEXT
email TEXT
created_at TEXT
```

---

## Security Checklist

✅ API keys stored in D1 (secure, not in code)  
✅ Stripe webhook signature verification  
✅ CORS headers configured  
✅ Source maps uploaded (debug in prod)  
✅ Stripe keys in `.env` (not committed)  
⚠️ **TODO:** Deliver API keys via email, not response  
⚠️ **TODO:** Implement rate limiting per tier  
⚠️ **TODO:** Add request validation & sanitization  
⚠️ **TODO:** Log all purchases & API key usage  

---

## Next Steps

1. **Frontend Dashboard** (`/metrics` + `/checkout` wired, solar system view)
2. **Rate Limiting** (implement in middleware)
3. **Email Service** (Sendgrid/Mailgun for API key delivery)
4. **Analytics** (segment events by tier, cohort analysis)
5. **Admin Panel** (refund purchases, revoke keys, view metrics)

---

## Stack

- **Runtime**: Cloudflare Workers
- **Database**: D1 (SQLite)
- **Payments**: Stripe
- **Language**: TypeScript
- **Bundler**: Wrangler
