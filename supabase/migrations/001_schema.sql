-- Christmas Sales Recorder - schema (Supabase / PostgreSQL 15+)
-- All money is stored as integer cents (MYR). All timestamps are timestamptz (UTC).
-- Business dates use the Asia/Kuala_Lumpur time zone.

create sequence if not exists sale_number_seq;

create or replace function business_date_now() returns date
language sql stable as $$ select (now() at time zone 'Asia/Kuala_Lumpur')::date $$;

-- ---------- people ----------
create table staff (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index staff_name_unique on staff (lower(btrim(name)));

-- Administrators / supervisors. Rows are created manually (see README).
create table admins (
  user_id uuid primary key,
  email text,
  role text not null default 'admin' check (role in ('admin','supervisor')),
  created_at timestamptz not null default now()
);

-- ---------- catalogue ----------
create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  sort_order int not null default 0
);

create table products (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) > 0),
  category_id uuid not null references categories(id),
  price_cents int not null check (price_cents >= 0),
  active boolean not null default true,
  sort_order int not null default 0
);

create table promotions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  promotion_type text not null default 'bundle_price' check (promotion_type in ('bundle_price')),
  promotional_price_cents int not null check (promotional_price_cents >= 0),
  -- {"bundle_size":6,"eligible_category_ids":["..."],"eligible_product_ids":["..."]}
  configuration jsonb not null default '{}'::jsonb,
  active boolean not null default true
);

-- ---------- shifts ----------
create table shifts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id),
  business_date date not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  status text not null default 'pending_allocation'
    check (status in ('pending_allocation','active','closing','pending_reconciliation','closed')),
  token_hash text not null,
  closed_at timestamptz,
  closed_by uuid,
  close_note text,
  created_at timestamptz not null default now()
);
-- A promoter can only have one shift that is not fully closed.
create unique index shifts_one_open_per_staff on shifts (staff_id) where status <> 'closed';
create index shifts_business_date_idx on shifts (business_date);

create table stock_allocations (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  shift_id uuid not null references shifts(id),
  product_id uuid not null references products(id),
  declared_quantity int not null check (declared_quantity >= 0),
  confirmed_quantity int check (confirmed_quantity >= 0),
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  declared_at timestamptz not null default now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  note text,
  unique (batch_id, product_id)
);
create index stock_allocations_shift_idx on stock_allocations (shift_id);

-- ---------- sales ----------
create table sales (
  id uuid primary key default gen_random_uuid(),
  idempotency_key uuid not null unique,
  sale_number text not null unique,
  shift_id uuid not null references shifts(id),
  staff_id uuid not null references staff(id),
  business_date date not null,
  payment_method text not null check (payment_method in ('cash','duitnow_qr')),
  subtotal_cents int not null check (subtotal_cents >= 0),
  discount_cents int not null default 0 check (discount_cents >= 0),
  total_cents int not null check (total_cents >= 0),
  cash_received_cents int check (cash_received_cents >= 0),
  change_cents int check (change_cents >= 0),
  status text not null default 'confirmed' check (status in ('confirmed','requires_review','voided')),
  review_reason text,
  review_note text,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  client_info jsonb not null default '{}'::jsonb,
  check (total_cents = subtotal_cents - discount_cents)
);
create index sales_shift_idx on sales (shift_id);
create index sales_business_date_idx on sales (business_date, status);
create index sales_review_idx on sales (status) where status = 'requires_review';

create table sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  product_id uuid not null references products(id),
  promotion_id uuid references promotions(id),
  quantity int not null check (quantity > 0),
  unit_price_cents int not null check (unit_price_cents >= 0),
  discount_cents int not null default 0 check (discount_cents >= 0),
  line_total_cents int not null check (line_total_cents >= 0),
  check (line_total_cents = quantity * unit_price_cents - discount_cents)
);
create index sale_items_sale_idx on sale_items (sale_id);
create index sale_items_product_idx on sale_items (product_id);

-- ---------- stock ledger ----------
-- Every change in stock is one or more rows here. Positive = more stock at that location.
-- location 'warehouse' = central warehouse, 'shift' = stock held by a promoter's shift.
create table stock_movements (
  id bigserial primary key,
  product_id uuid not null references products(id),
  shift_id uuid references shifts(id),
  location text not null check (location in ('warehouse','shift')),
  movement_type text not null check (movement_type in
    ('receipt','adjustment','allocation','sale','sale_void','return','loss','count_adjustment')),
  quantity_change int not null check (quantity_change <> 0),
  reference_id uuid,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (location = 'warehouse' or shift_id is not null)
);
create index stock_movements_wh_idx on stock_movements (product_id) where location = 'warehouse';
create index stock_movements_shift_idx on stock_movements (shift_id, product_id) where location = 'shift';

create table stock_counts (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references shifts(id),
  product_id uuid not null references products(id),
  expected_quantity int not null,
  actual_quantity int not null check (actual_quantity >= 0),
  difference int not null,
  created_at timestamptz not null default now(),
  unique (shift_id, product_id)
);

create table stock_returns (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references shifts(id),
  product_id uuid not null references products(id),
  declared_quantity int,
  expected_quantity int not null,
  confirmed_quantity int not null check (confirmed_quantity >= 0),
  difference int not null,
  discrepancy_status text not null default 'ok' check (discrepancy_status in ('ok','open','acknowledged')),
  notes text,
  confirmed_by uuid,
  confirmed_at timestamptz not null default now(),
  ack_note text,
  ack_by uuid,
  ack_at timestamptz,
  unique (shift_id, product_id)
);

create table cash_settlements (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null unique references shifts(id),
  expected_cash_cents int not null default 0,
  declared_cash_cents int check (declared_cash_cents >= 0),
  received_cash_cents int check (received_cash_cents >= 0),
  cash_float_cents int not null default 0 check (cash_float_cents >= 0),
  adjustment_cents int not null default 0,
  difference_cents int,
  status text not null default 'pending_handover'
    check (status in ('pending_handover','received','discrepancy','reconciled')),
  declared_at timestamptz,
  confirmed_by uuid,
  confirmed_at timestamptz,
  notes text,
  ack_note text
);

create table audit_logs (
  id bigserial primary key,
  actor_type text not null check (actor_type in ('admin','promoter','system')),
  actor_id text,
  action text not null,
  entity_type text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_created_idx on audit_logs (created_at desc);
