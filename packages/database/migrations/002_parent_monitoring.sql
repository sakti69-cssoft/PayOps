CREATE TABLE parent_sources (
  id text PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  parent_merchant_id uuid NOT NULL,
  base_url text NOT NULL,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  sync_status text NOT NULL DEFAULT 'never' CHECK(sync_status IN ('never','syncing','ok','partial','error'))
);
CREATE TABLE parent_transactions (
  id uuid PRIMARY KEY,
  source_id text NOT NULL REFERENCES parent_sources(id),
  parent_id uuid NOT NULL,
  device_id uuid NOT NULL,
  reference text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  currency text NOT NULL CHECK(currency='INR'),
  payment_status text NOT NULL CHECK(payment_status IN ('PENDING','SUCCESS','FAILED')),
  announcement_status text NOT NULL CHECK(announcement_status IN ('PENDING','PUBLISHED','DELIVERED','FAILED')),
  parent_created_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  UNIQUE(source_id,parent_id)
);
CREATE INDEX parent_transactions_source_time ON parent_transactions(source_id,parent_created_at DESC,id);
