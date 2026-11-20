-- Christmas Sales Recorder - transactional business logic.
-- Promoter-facing functions are named api_* and are callable ONLY by the service role
-- (i.e. from the Netlify function). Administrator functions are named admin_* and are callable
-- by signed-in Supabase users, but every one of them checks the admins table first.

-- ======================================================================
-- helpers
-- ======================================================================
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid())
$$;

create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid() and a.role = 'admin')
$$;

create or replace function _require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'not_authorized' using errcode = '42501'; end if;
end $$;

create or replace function _require_owner() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'not_authorized' using errcode = '42501'; end if;
end $$;

create or replace function _audit(p_actor_type text, p_actor text, p_action text,
                                  p_entity_type text, p_entity_id text, p_details jsonb)
returns void language sql security definer set search_path = public as $$
  insert into audit_logs(actor_type, actor_id, action, entity_type, entity_id, details)
  values (p_actor_type, p_actor, p_action, p_entity_type, p_entity_id, coalesce(p_details, '{}'::jsonb))
$$;

create or replace function _shift_json(s shifts) returns jsonb
language sql immutable as $$
  select jsonb_build_object('id', s.id, 'staff_id', s.staff_id, 'business_date', s.business_date,
                            'status', s.status, 'started_at', s.started_at, 'ended_at', s.ended_at)
$$;

create or replace function shift_balance(p_shift uuid, p_product uuid) returns int
language sql stable as $$
  select coalesce(sum(quantity_change), 0)::int from stock_movements
  where shift_id = p_shift and location = 'shift' and product_id = p_product
$$;

create or replace function warehouse_balance(p_product uuid) returns int
language sql stable as $$
  select coalesce(sum(quantity_change), 0)::int from stock_movements
  where location = 'warehouse' and product_id = p_product
$$;

create or replace function _check_shift(p_shift_id uuid, p_hash text, p_lock boolean default false)
returns shifts language plpgsql security definer set search_path = public as $$
declare s shifts;
begin
  if p_hash is null or length(p_hash) < 16 then raise exception 'invalid_shift' using errcode = '28000'; end if;
  if p_lock then
    select * into s from shifts where id = p_shift_id and token_hash = p_hash for update;
  else
    select * into s from shifts where id = p_shift_id and token_hash = p_hash;
  end if;
  if not found then raise exception 'invalid_shift' using errcode = '28000'; end if;
  return s;
end $$;

-- ======================================================================
-- pricing (server side - the browser's prices are never trusted)
-- ======================================================================
create or replace function _price_cart(p_lines jsonb, p_bundles jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  items jsonb := '[]'::jsonb;
  subtotal int := 0;
  discount int := 0;
  r record;
  b jsonb;
  promo promotions;
  cfg jsonb;
  bsize int; bsub int; bdisc int; remaining int; i int; n int; qty_sum int; ls int;
  elig_cat uuid[]; elig_prod uuid[];
  pids uuid[]; qtys int[]; units int[]; shares int[]; cats uuid[];
  progress boolean;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then p_lines := '[]'::jsonb; end if;
  if p_bundles is null or jsonb_typeof(p_bundles) <> 'array' then p_bundles := '[]'::jsonb; end if;
  if jsonb_array_length(p_lines) + jsonb_array_length(p_bundles) = 0 then raise exception 'empty_cart'; end if;
  if jsonb_array_length(p_lines) > 50 or jsonb_array_length(p_bundles) > 20 then raise exception 'cart_too_large'; end if;

  if exists (select 1 from jsonb_to_recordset(p_lines) as x(product_id uuid, quantity int)
             where x.product_id is null or x.quantity is null or x.quantity < 1 or x.quantity > 999) then
    raise exception 'invalid_quantity';
  end if;

  -- ordinary lines, merged per product
  for r in select x.product_id, sum(x.quantity)::int as quantity
           from jsonb_to_recordset(p_lines) as x(product_id uuid, quantity int)
           group by x.product_id order by x.product_id
  loop
    declare pr products;
    begin
      select * into pr from products where id = r.product_id;
      if not found then raise exception 'unknown_product'; end if;
      items := items || jsonb_build_object('product_id', pr.id, 'quantity', r.quantity,
                 'unit', pr.price_cents, 'discount', 0, 'promotion_id', null);
      subtotal := subtotal + r.quantity * pr.price_cents;
    end;
  end loop;

  -- promotion bundles
  for b in select * from jsonb_array_elements(p_bundles)
  loop
    select * into promo from promotions where id = (b->>'promotion_id')::uuid and active;
    if not found then raise exception 'unknown_promotion'; end if;
    cfg := promo.configuration;
    bsize := coalesce((cfg->>'bundle_size')::int, 6);
    select coalesce(array_agg(v::uuid), '{}') into elig_cat
      from jsonb_array_elements_text(coalesce(cfg->'eligible_category_ids', '[]'::jsonb)) v;
    select coalesce(array_agg(v::uuid), '{}') into elig_prod
      from jsonb_array_elements_text(coalesce(cfg->'eligible_product_ids', '[]'::jsonb)) v;
    if cardinality(elig_cat) = 0 and cardinality(elig_prod) = 0 then raise exception 'promotion_not_configured'; end if;

    if exists (select 1 from jsonb_to_recordset(coalesce(b->'items', '[]'::jsonb)) as x(product_id uuid, quantity int)
               where x.product_id is null or x.quantity is null or x.quantity < 1 or x.quantity > 999) then
      raise exception 'invalid_quantity';
    end if;

    select array_agg(t.product_id order by t.product_id), array_agg(t.q order by t.product_id),
           array_agg(p.price_cents order by t.product_id), array_agg(p.category_id order by t.product_id)
      into pids, qtys, units, cats
      from (select x.product_id, sum(x.quantity)::int as q
              from jsonb_to_recordset(coalesce(b->'items', '[]'::jsonb)) as x(product_id uuid, quantity int)
             group by x.product_id) t
      join products p on p.id = t.product_id;
    n := coalesce(cardinality(pids), 0);
    if n = 0 then raise exception 'invalid_bundle_size'; end if;
    if n <> (select count(distinct x.product_id) from jsonb_to_recordset(b->'items') as x(product_id uuid, quantity int)) then
      raise exception 'unknown_product';
    end if;

    qty_sum := 0; bsub := 0;
    for i in 1..n loop
      if not (pids[i] = any(elig_prod) or cats[i] = any(elig_cat)) then raise exception 'product_not_eligible'; end if;
      qty_sum := qty_sum + qtys[i];
      bsub := bsub + qtys[i] * units[i];
    end loop;
    if qty_sum <> bsize then raise exception 'invalid_bundle_size'; end if;

    bdisc := greatest(bsub - promo.promotional_price_cents, 0);
    shares := array_fill(0, array[n]);
    remaining := bdisc;
    if bsub > 0 then
      for i in 1..n loop
        shares[i] := floor(bdisc::numeric * (qtys[i] * units[i]) / bsub)::int;
        remaining := remaining - shares[i];
      end loop;
      -- hand out the leftover cents, one at a time, to lines that still have room
      while remaining > 0 loop
        progress := false;
        for i in 1..n loop
          exit when remaining = 0;
          if shares[i] < qtys[i] * units[i] then
            shares[i] := shares[i] + 1; remaining := remaining - 1; progress := true;
          end if;
        end loop;
        exit when not progress;
      end loop;
    end if;

    for i in 1..n loop
      items := items || jsonb_build_object('product_id', pids[i], 'quantity', qtys[i], 'unit', units[i],
                 'discount', shares[i], 'promotion_id', promo.id);
    end loop;
    subtotal := subtotal + bsub;
    discount := discount + bdisc;
  end loop;

  return jsonb_build_object('items', items, 'subtotal', subtotal, 'discount', discount, 'total', subtotal - discount);
end $$;

-- ======================================================================
-- stock helpers
-- ======================================================================
-- Move a confirmed sale's stock out of the shift. Caller must already hold the shift row lock.
create or replace function _sale_take_stock(p_sale_id uuid, p_shift_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into stock_movements(product_id, shift_id, location, movement_type, quantity_change, reference_id)
  select si.product_id, p_shift_id, 'shift', 'sale', -sum(si.quantity)::int, p_sale_id
    from sale_items si where si.sale_id = p_sale_id group by si.product_id
$$;

create or replace function _sale_has_stock(p_sale_id uuid, p_shift_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from sale_items si where si.sale_id = p_sale_id
    group by si.product_id
    having sum(si.quantity) > shift_balance(p_shift_id, si.product_id))
$$;

-- When stock arrives (allocation confirmed) sales that were waiting for stock are re-checked in order.
create or replace function _reevaluate_reviews(p_shift_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from sales
            where shift_id = p_shift_id and status = 'requires_review' and review_reason = 'insufficient_stock'
            order by occurred_at, created_at
  loop
    if _sale_has_stock(r.id, p_shift_id) then
      perform _sale_take_stock(r.id, p_shift_id);
      update sales set status = 'confirmed', review_reason = null where id = r.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- If something changes on a shift that was already closed it goes back to reconciliation.
create or replace function _reopen_if_closed(p_shift_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare s shifts;
begin
  select * into s from shifts where id = p_shift_id for update;
  if s.status = 'closed' then
    update shifts set status = 'pending_reconciliation', closed_at = null, closed_by = null where id = s.id;
    update cash_settlements set status = 'pending_handover', difference_cents = null
      where shift_id = s.id and status in ('received','reconciled','discrepancy');
    perform _audit('admin', auth.uid()::text, 'shift_reopened', 'shift', s.id::text, jsonb_build_object('reason', p_reason));
  end if;
end $$;

create or replace function _shift_summary(p_shift_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'shift', _shift_json(s),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', p.id, 'name', p.name, 'category', c.name,
               'declared', coalesce(a.declared, 0), 'allocated', coalesce(a.confirmed, 0),
               'sold', coalesce(sd.qty, 0), 'balance', shift_balance(s.id, p.id))
             order by c.sort_order, p.sort_order, p.name)
        from products p
        join categories c on c.id = p.category_id
        left join (select product_id, sum(declared_quantity) as declared,
                          sum(coalesce(confirmed_quantity, 0)) as confirmed
                     from stock_allocations where shift_id = s.id group by product_id) a on a.product_id = p.id
        left join (select si.product_id, sum(si.quantity) as qty
                     from sale_items si join sales sa on sa.id = si.sale_id
                    where sa.shift_id = s.id and sa.status = 'confirmed' group by si.product_id) sd on sd.product_id = p.id
       where a.product_id is not null or sd.product_id is not null or shift_balance(s.id, p.id) <> 0
    ), '[]'::jsonb),
    'pending_allocation_rows', (select count(*) from stock_allocations where shift_id = s.id and status = 'pending'),
    'totals', (
      select jsonb_build_object(
        'sales_count', count(*) filter (where status = 'confirmed'),
        'total_cents', coalesce(sum(total_cents) filter (where status = 'confirmed'), 0),
        'cash_cents', coalesce(sum(total_cents) filter (where status = 'confirmed' and payment_method = 'cash'), 0),
        'qr_cents', coalesce(sum(total_cents) filter (where status = 'confirmed' and payment_method = 'duitnow_qr'), 0),
        'review_count', count(*) filter (where status = 'requires_review'))
        from sales where shift_id = s.id),
    'cash', (select to_jsonb(cs) - 'id' from cash_settlements cs where cs.shift_id = s.id)
  ) from shifts s where s.id = p_shift_id
$$;

-- ======================================================================
-- PROMOTER API (service role only)
-- ======================================================================
create or replace function api_start_shift(p_staff_id uuid, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shifts; st staff; resumed boolean := false; rotated boolean := false;
begin
  if p_token_hash is null or length(p_token_hash) < 16 then raise exception 'invalid_token'; end if;
  select * into st from staff where id = p_staff_id and active;
  if not found then raise exception 'unknown_staff'; end if;
  perform pg_advisory_xact_lock(hashtextextended('shift:' || p_staff_id::text, 0));
  select * into s from shifts where staff_id = p_staff_id and status <> 'closed'
   order by started_at desc limit 1 for update;
  if found then
    resumed := true;
    if s.token_hash <> p_token_hash then
      update shifts set token_hash = p_token_hash where id = s.id returning * into s;
      rotated := true;
    end if;
  else
    insert into shifts(staff_id, business_date, token_hash)
    values (p_staff_id, business_date_now(), p_token_hash) returning * into s;
  end if;
  perform _audit('promoter', p_staff_id::text, case when resumed then 'shift_resumed' else 'shift_started' end,
                 'shift', s.id::text, jsonb_build_object('token_rotated', rotated));
  return jsonb_build_object('shift', _shift_json(s), 'resumed', resumed, 'token_rotated', rotated,
                            'staff_name', st.name);
end $$;

create or replace function api_declare_allocation(p_shift_id uuid, p_hash text, p_batch_id uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s shifts; n int;
begin
  s := _check_shift(p_shift_id, p_hash, true);
  if s.status not in ('pending_allocation', 'active') then raise exception 'shift_not_open'; end if;
  if exists (select 1 from stock_allocations where batch_id = p_batch_id and shift_id = s.id) then
    return jsonb_build_object('batch_id', p_batch_id, 'duplicate', true);
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0
     or jsonb_array_length(p_items) > 200 then raise exception 'invalid_items'; end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(product_id uuid, quantity int)
             where x.product_id is null or x.quantity is null or x.quantity < 1 or x.quantity > 100000) then
    raise exception 'invalid_quantity';
  end if;
  insert into stock_allocations(batch_id, shift_id, product_id, declared_quantity)
  select p_batch_id, s.id, x.product_id, sum(x.quantity)::int
    from jsonb_to_recordset(p_items) as x(product_id uuid, quantity int)
    join products p on p.id = x.product_id
   group by x.product_id;
  get diagnostics n = row_count;
  if n <> (select count(distinct x.product_id) from jsonb_to_recordset(p_items) as x(product_id uuid, quantity int)) then
    raise exception 'unknown_product';
  end if;
  perform _audit('promoter', s.staff_id::text, 'allocation_declared', 'shift', s.id::text,
                 jsonb_build_object('batch_id', p_batch_id, 'items', p_items));
  return jsonb_build_object('batch_id', p_batch_id, 'duplicate', false, 'rows', n);
end $$;

create or replace function api_create_sale(
  p_shift_id uuid, p_hash text, p_key uuid, p_payment text,
  p_lines jsonb, p_bundles jsonb, p_cash_received_cents int,
  p_occurred_at timestamptz, p_client jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s shifts; ex sales; priced jsonb; total int; occ timestamptz;
  st text := 'confirmed'; reason text := null; sid uuid; sno text; chg int; cash_in int := p_cash_received_cents;
  short boolean; it jsonb;
begin
  -- locking the shift row serialises all sales of one shift (and makes duplicate retries safe)
  s := _check_shift(p_shift_id, p_hash, true);

  select * into ex from sales where idempotency_key = p_key;
  if found then
    if ex.shift_id <> s.id then raise exception 'idempotency_conflict'; end if;
    return jsonb_build_object('sale_id', ex.id, 'sale_number', ex.sale_number, 'status', ex.status,
                              'total_cents', ex.total_cents, 'review_reason', ex.review_reason, 'duplicate', true);
  end if;

  if p_payment is null or p_payment not in ('cash', 'duitnow_qr') then raise exception 'invalid_payment'; end if;
  priced := _price_cart(p_lines, p_bundles);
  total := (priced->>'total')::int;

  if p_payment = 'cash' then
    if cash_in is null or cash_in < total then raise exception 'insufficient_cash'; end if;
    if cash_in > 100000000 then raise exception 'invalid_cash_amount'; end if;
    chg := cash_in - total;
  else
    cash_in := null; chg := null;
  end if;

  occ := least(coalesce(p_occurred_at, now()), now());
  if occ < now() - interval '60 days' then raise exception 'invalid_time'; end if;

  if s.status = 'closed' then st := 'requires_review'; reason := 'shift_closed';
  elsif s.ended_at is not null and occ > s.ended_at + interval '1 minute' then st := 'requires_review'; reason := 'after_shift_end';
  elsif occ < s.started_at - interval '10 minutes' then st := 'requires_review'; reason := 'before_shift_start';
  end if;

  if st = 'confirmed' then
    select exists (
      select 1 from (select (x->>'product_id')::uuid as product_id, sum((x->>'quantity')::int) as q
                       from jsonb_array_elements(priced->'items') x group by 1) n
      where shift_balance(s.id, n.product_id) < n.q) into short;
    if short then st := 'requires_review'; reason := 'insufficient_stock'; end if;
  end if;

  sno := 'S' || to_char(s.business_date, 'YYMMDD') || '-' || lpad(nextval('sale_number_seq')::text, 5, '0');
  insert into sales(idempotency_key, sale_number, shift_id, staff_id, business_date, payment_method,
                    subtotal_cents, discount_cents, total_cents, cash_received_cents, change_cents,
                    status, review_reason, occurred_at, client_info)
  values (p_key, sno, s.id, s.staff_id, s.business_date, p_payment,
          (priced->>'subtotal')::int, (priced->>'discount')::int, total, cash_in, chg,
          st, reason, occ, coalesce(p_client, '{}'::jsonb))
  returning id into sid;

  for it in select * from jsonb_array_elements(priced->'items') loop
    insert into sale_items(sale_id, product_id, promotion_id, quantity, unit_price_cents, discount_cents, line_total_cents)
    values (sid, (it->>'product_id')::uuid, nullif(it->>'promotion_id', '')::uuid, (it->>'quantity')::int,
            (it->>'unit')::int, (it->>'discount')::int,
            (it->>'quantity')::int * (it->>'unit')::int - (it->>'discount')::int);
  end loop;

  if st = 'confirmed' then
    perform _sale_take_stock(sid, s.id);
  else
    perform _audit('system', s.staff_id::text, 'sale_requires_review', 'sale', sid::text,
                   jsonb_build_object('reason', reason, 'sale_number', sno));
  end if;

  return jsonb_build_object('sale_id', sid, 'sale_number', sno, 'status', st, 'total_cents', total,
                            'review_reason', reason, 'duplicate', false,
                            'discount_cents', (priced->>'discount')::int,
                            'change_cents', chg);
end $$;

create or replace function api_end_shift(p_shift_id uuid, p_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shifts;
begin
  s := _check_shift(p_shift_id, p_hash, true);
  if s.status in ('pending_allocation', 'active') then
    update shifts set status = 'closing', ended_at = now() where id = s.id;
    perform _audit('promoter', s.staff_id::text, 'shift_ended', 'shift', s.id::text, '{}'::jsonb);
  end if;
  return _shift_summary(s.id);
end $$;

create or replace function api_shift_summary(p_shift_id uuid, p_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shifts;
begin
  s := _check_shift(p_shift_id, p_hash, false);
  return _shift_summary(s.id);
end $$;

create or replace function api_my_sales(p_shift_id uuid, p_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shifts;
begin
  s := _check_shift(p_shift_id, p_hash, false);
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', sa.id, 'key', sa.idempotency_key, 'sale_number', sa.sale_number,
             'status', sa.status, 'review_reason', sa.review_reason, 'payment_method', sa.payment_method,
             'total_cents', sa.total_cents, 'occurred_at', sa.occurred_at) order by sa.occurred_at desc)
      from sales sa where sa.shift_id = s.id), '[]'::jsonb);
end $$;

create or replace function api_submit_closing(p_shift_id uuid, p_hash text, p_counts jsonb, p_declared_cash_cents int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s shifts; r record; bal int; expected_cash int; missing text;
begin
  s := _check_shift(p_shift_id, p_hash, true);
  if s.status not in ('closing', 'pending_reconciliation') then raise exception 'shift_not_ended'; end if;
  if p_declared_cash_cents is null or p_declared_cash_cents < 0 or p_declared_cash_cents > 100000000 then
    raise exception 'invalid_cash_amount';
  end if;
  if p_counts is null or jsonb_typeof(p_counts) <> 'array' then raise exception 'invalid_items'; end if;
  if exists (select 1 from jsonb_to_recordset(p_counts) as x(product_id uuid, actual_quantity int)
             where x.product_id is null or x.actual_quantity is null or x.actual_quantity < 0 or x.actual_quantity > 100000) then
    raise exception 'invalid_quantity';
  end if;
  if exists (select 1 from cash_settlements where shift_id = s.id and status in ('received', 'reconciled')) then
    raise exception 'already_confirmed';
  end if;
  if exists (select 1 from stock_returns where shift_id = s.id) then raise exception 'already_confirmed'; end if;

  -- every product that should still be in the promoter's hands must be counted
  select string_agg(p.name, ', ') into missing
    from products p
   where shift_balance(s.id, p.id) > 0
     and not exists (select 1 from jsonb_to_recordset(p_counts) as x(product_id uuid, actual_quantity int)
                      where x.product_id = p.id);
  if missing is not null then raise exception 'missing_count: %', missing; end if;

  for r in select x.product_id, max(x.actual_quantity)::int as actual
             from jsonb_to_recordset(p_counts) as x(product_id uuid, actual_quantity int)
             join products p on p.id = x.product_id group by x.product_id
  loop
    bal := shift_balance(s.id, r.product_id);
    insert into stock_counts(shift_id, product_id, expected_quantity, actual_quantity, difference)
    values (s.id, r.product_id, bal, r.actual, r.actual - bal)
    on conflict (shift_id, product_id) do update
      set expected_quantity = excluded.expected_quantity, actual_quantity = excluded.actual_quantity,
          difference = excluded.difference, created_at = now();
  end loop;

  select coalesce(sum(total_cents), 0)::int into expected_cash
    from sales where shift_id = s.id and status = 'confirmed' and payment_method = 'cash';
  insert into cash_settlements(shift_id, expected_cash_cents, declared_cash_cents, declared_at, status)
  values (s.id, expected_cash, p_declared_cash_cents, now(), 'pending_handover')
  on conflict (shift_id) do update
    set expected_cash_cents = excluded.expected_cash_cents, declared_cash_cents = excluded.declared_cash_cents,
        declared_at = now(), status = 'pending_handover';

  update shifts set status = 'pending_reconciliation' where id = s.id;
  perform _audit('promoter', s.staff_id::text, 'closing_submitted', 'shift', s.id::text,
                 jsonb_build_object('counts', p_counts, 'declared_cash_cents', p_declared_cash_cents));
  return _shift_summary(s.id) || jsonb_build_object('counts', coalesce((
    select jsonb_agg(jsonb_build_object('product_id', product_id, 'expected', expected_quantity,
                                        'actual', actual_quantity, 'difference', difference))
      from stock_counts where shift_id = s.id), '[]'::jsonb));
end $$;

-- ======================================================================
-- ADMIN: warehouse
-- ======================================================================
create or replace function admin_record_receipt(p_product_id uuid, p_quantity int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner();
  if p_quantity is null or p_quantity < 1 or p_quantity > 1000000 then raise exception 'invalid_quantity'; end if;
  perform 1 from products where id = p_product_id for update;
  if not found then raise exception 'unknown_product'; end if;
  insert into stock_movements(product_id, location, movement_type, quantity_change, note, created_by)
  values (p_product_id, 'warehouse', 'receipt', p_quantity, p_note, auth.uid());
  perform _audit('admin', auth.uid()::text, 'warehouse_receipt', 'product', p_product_id::text,
                 jsonb_build_object('quantity', p_quantity, 'note', p_note));
  return jsonb_build_object('warehouse_balance', warehouse_balance(p_product_id));
end $$;

create or replace function admin_adjust_warehouse(p_product_id uuid, p_delta int, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _require_owner();
  if p_delta is null or p_delta = 0 or abs(p_delta) > 1000000 then raise exception 'invalid_quantity'; end if;
  if p_note is null or length(btrim(p_note)) < 3 then raise exception 'note_required'; end if;
  perform 1 from products where id = p_product_id for update;
  if not found then raise exception 'unknown_product'; end if;
  if warehouse_balance(p_product_id) + p_delta < 0 then raise exception 'insufficient_warehouse_stock'; end if;
  insert into stock_movements(product_id, location, movement_type, quantity_change, note, created_by)
  values (p_product_id, 'warehouse', 'adjustment', p_delta, p_note, auth.uid());
  perform _audit('admin', auth.uid()::text, 'warehouse_adjustment', 'product', p_product_id::text,
                 jsonb_build_object('delta', p_delta, 'note', p_note));
  return jsonb_build_object('warehouse_balance', warehouse_balance(p_product_id));
end $$;

-- ======================================================================
-- ADMIN: allocation, sales review
-- ======================================================================
create or replace function _confirm_allocation_row(p_shift shifts, p_alloc_id uuid, p_product uuid, p_qty int) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_qty > 0 then
    perform 1 from products where id = p_product for update;
    if warehouse_balance(p_product) < p_qty then
      raise exception 'insufficient_warehouse_stock' using detail = p_product::text;
    end if;
    insert into stock_movements(product_id, shift_id, location, movement_type, quantity_change, reference_id, created_by)
    values (p_product, p_shift.id, 'warehouse', 'allocation', -p_qty, p_alloc_id, auth.uid()),
           (p_product, p_shift.id, 'shift', 'allocation', p_qty, p_alloc_id, auth.uid());
  end if;
  update stock_allocations
     set confirmed_quantity = p_qty, status = case when p_qty > 0 then 'confirmed' else 'rejected' end,
         confirmed_by = auth.uid(), confirmed_at = now()
   where id = p_alloc_id;
  return p_qty > 0;
end $$;

create or replace function admin_confirm_allocation(p_shift_id uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shifts; r record; any_conf boolean := false; n int := 0;
begin
  perform _require_admin();
  select * into s from shifts where id = p_shift_id for update;
  if not found then raise exception 'unknown_shift'; end if;
  if s.status in ('pending_reconciliation', 'closed') then raise exception 'shift_not_open'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'invalid_items'; end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(allocation_id uuid, confirmed_quantity int)
             where x.allocation_id is null or x.confirmed_quantity is null
                or x.confirmed_quantity < 0 or x.confirmed_quantity > 100000) then
    raise exception 'invalid_quantity';
  end if;

  -- lock in a fixed order so two supervisors can never deadlock
  for r in select x.allocation_id, x.confirmed_quantity, a.product_id
             from jsonb_to_recordset(p_items) as x(allocation_id uuid, confirmed_quantity int)
             join stock_allocations a on a.id = x.allocation_id and a.shift_id = p_shift_id
            order by a.product_id, a.id
  loop
    perform 1 from stock_allocations where id = r.allocation_id and status = 'pending' for update;
    if not found then raise exception 'allocation_not_pending'; end if;
    if _confirm_allocation_row(s, r.allocation_id, r.product_id, r.confirmed_quantity) then any_conf := true; end if;
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'nothing_to_confirm'; end if;
  if s.status = 'pending_allocation' and any_conf then update shifts set status = 'active' where id = s.id; end if;
  perform _reevaluate_reviews(s.id);
  perform _audit('admin', auth.uid()::text, 'allocation_confirmed', 'shift', s.id::text, jsonb_build_object('items', p_items));
  return _shift_summary(s.id);
end $$;

create or replace function admin_allocate_stock(p_shift_id uuid, p_product_id uuid, p_quantity int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shifts; aid uuid := gen_random_uuid();
begin
  perform _require_admin();
  if p_quantity is null or p_quantity < 1 or p_quantity > 100000 then raise exception 'invalid_quantity'; end if;
  select * into s from shifts where id = p_shift_id for update;
  if not found then raise exception 'unknown_shift'; end if;
  if s.status in ('pending_reconciliation', 'closed') then raise exception 'shift_not_open'; end if;
  perform 1 from products where id = p_product_id;
  if not found then raise exception 'unknown_product'; end if;
  insert into stock_allocations(id, batch_id, shift_id, product_id, declared_quantity, note)
  values (aid, gen_random_uuid(), s.id, p_product_id, p_quantity, coalesce(p_note, 'manual allocation by administrator'));
  perform _confirm_allocation_row(s, aid, p_product_id, p_quantity);
  if s.status = 'pending_allocation' then update shifts set status = 'active' where id = s.id; end if;
  perform _reevaluate_reviews(s.id);
  perform _audit('admin', auth.uid()::text, 'manual_allocation', 'shift', s.id::text,
                 jsonb_build_object('product_id', p_product_id, 'quantity', p_quantity, 'note', p_note));
  return _shift_summary(s.id);
end $$;

create or replace function admin_resolve_sale(p_sale_id uuid, p_action text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sa sales; s shifts;
begin
  perform _require_admin();
  if p_action not in ('approve', 'void') then raise exception 'invalid_action'; end if;
  if p_note is null or length(btrim(p_note)) < 3 then raise exception 'note_required'; end if;
  select * into sa from sales where id = p_sale_id;
  if not found then raise exception 'unknown_sale'; end if;
  select * into s from shifts where id = sa.shift_id for update;
  select * into sa from sales where id = p_sale_id for update;
  if sa.status <> 'requires_review' then raise exception 'sale_not_in_review'; end if;
  if p_action = 'void' then
    update sales set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = p_note, review_note = p_note
     where id = sa.id;
  else
    if not _sale_has_stock(sa.id, s.id) then raise exception 'insufficient_stock'; end if;
    perform _sale_take_stock(sa.id, s.id);
    update sales set status = 'confirmed', review_note = p_note, review_reason = null where id = sa.id;
  end if;
  perform _reopen_if_closed(s.id, 'sale ' || sa.sale_number || ' ' || p_action);
  perform _audit('admin', auth.uid()::text, 'sale_review_' || p_action, 'sale', sa.id::text, jsonb_build_object('note', p_note));
  return jsonb_build_object('sale_id', sa.id, 'status', case when p_action = 'void' then 'voided' else 'confirmed' end);
end $$;

create or replace function admin_void_sale(p_sale_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sa sales; s shifts;
begin
  perform _require_owner();
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'note_required'; end if;
  select * into sa from sales where id = p_sale_id;
  if not found then raise exception 'unknown_sale'; end if;
  select * into s from shifts where id = sa.shift_id for update;
  select * into sa from sales where id = p_sale_id for update;
  if sa.status = 'voided' then raise exception 'already_voided'; end if;
  if sa.status = 'confirmed' then
    insert into stock_movements(product_id, shift_id, location, movement_type, quantity_change, reference_id, created_by, note)
    select si.product_id, s.id, 'shift', 'sale_void', sum(si.quantity)::int, sa.id, auth.uid(), p_reason
      from sale_items si where si.sale_id = sa.id group by si.product_id;
  end if;
  update sales set status = 'voided', voided_at = now(), voided_by = auth.uid(), void_reason = p_reason where id = sa.id;
  perform _reopen_if_closed(s.id, 'sale ' || sa.sale_number || ' voided');
  perform _audit('admin', auth.uid()::text, 'sale_voided', 'sale', sa.id::text, jsonb_build_object('reason', p_reason));
  return jsonb_build_object('sale_id', sa.id, 'status', 'voided');
end $$;

-- ======================================================================
-- ADMIN: stock return, cash, closing
-- ======================================================================
create or replace function admin_confirm_return(p_shift_id uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shifts; r record; bal int; decl int; diffs jsonb := '[]'::jsonb;
begin
  perform _require_admin();
  select * into s from shifts where id = p_shift_id for update;
  if not found then raise exception 'unknown_shift'; end if;
  if s.status <> 'pending_reconciliation' then raise exception 'shift_not_ready_for_return'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'invalid_items'; end if;
  if exists (select 1 from jsonb_to_recordset(p_items) as x(product_id uuid, confirmed_quantity int, note text)
             where x.product_id is null or x.confirmed_quantity is null
                or x.confirmed_quantity < 0 or x.confirmed_quantity > 100000) then
    raise exception 'invalid_quantity';
  end if;

  for r in select x.product_id, max(x.confirmed_quantity)::int as qty, max(x.note) as note
             from jsonb_to_recordset(p_items) as x(product_id uuid, confirmed_quantity int, note text)
             join products p on p.id = x.product_id
            group by x.product_id order by x.product_id
  loop
    if exists (select 1 from stock_returns where shift_id = s.id and product_id = r.product_id) then
      raise exception 'already_confirmed';
    end if;
    perform 1 from products where id = r.product_id for update;
    bal := shift_balance(s.id, r.product_id);
    select actual_quantity into decl from stock_counts where shift_id = s.id and product_id = r.product_id;
    if r.qty > bal then
      -- more came back than the ledger says: record the surplus explicitly instead of hiding it
      insert into stock_movements(product_id, shift_id, location, movement_type, quantity_change, note, created_by)
      values (r.product_id, s.id, 'shift', 'count_adjustment', r.qty - bal, 'surplus found at return', auth.uid());
    end if;
    if r.qty > 0 then
      insert into stock_movements(product_id, shift_id, location, movement_type, quantity_change, created_by)
      values (r.product_id, s.id, 'shift', 'return', -r.qty, auth.uid()),
             (r.product_id, s.id, 'warehouse', 'return', r.qty, auth.uid());
    end if;
    insert into stock_returns(shift_id, product_id, declared_quantity, expected_quantity, confirmed_quantity,
                              difference, discrepancy_status, notes, confirmed_by)
    values (s.id, r.product_id, decl, bal, r.qty, r.qty - bal,
            case when r.qty = bal then 'ok' else 'open' end, r.note, auth.uid());
    if r.qty <> bal then
      diffs := diffs || jsonb_build_object('product_id', r.product_id, 'expected', bal, 'confirmed', r.qty, 'difference', r.qty - bal);
    end if;
  end loop;
  perform _audit('admin', auth.uid()::text, 'return_confirmed', 'shift', s.id::text,
                 jsonb_build_object('items', p_items, 'differences', diffs));
  return jsonb_build_object('differences', diffs, 'summary', _shift_summary(s.id));
end $$;

create or replace function admin_acknowledge_stock_difference(p_shift_id uuid, p_product_id uuid, p_note text, p_write_off boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare ret stock_returns; bal int;
begin
  perform _require_admin();
  if p_note is null or length(btrim(p_note)) < 3 then raise exception 'note_required'; end if;
  select * into ret from stock_returns where shift_id = p_shift_id and product_id = p_product_id for update;
  if not found then raise exception 'return_not_confirmed'; end if;
  if ret.discrepancy_status <> 'open' then raise exception 'nothing_to_acknowledge'; end if;
  bal := shift_balance(p_shift_id, p_product_id);
  if bal > 0 then
    if not coalesce(p_write_off, false) then raise exception 'balance_remaining'; end if;
    insert into stock_movements(product_id, shift_id, location, movement_type, quantity_change, note, created_by)
    values (p_product_id, p_shift_id, 'shift', 'loss', -bal, p_note, auth.uid());
  end if;
  update stock_returns set discrepancy_status = 'acknowledged', ack_note = p_note, ack_by = auth.uid(), ack_at = now()
   where id = ret.id;
  perform _audit('admin', auth.uid()::text, 'stock_difference_acknowledged', 'shift', p_shift_id::text,
                 jsonb_build_object('product_id', p_product_id, 'written_off', greatest(bal, 0), 'note', p_note));
  return jsonb_build_object('product_id', p_product_id, 'written_off', greatest(bal, 0));
end $$;

create or replace function admin_confirm_cash(p_shift_id uuid, p_received_cents int, p_float_cents int default 0,
                                              p_adjustment_cents int default 0, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s shifts; cs cash_settlements; expected int; diff int; st text;
begin
  perform _require_admin();
  if p_received_cents is null or p_received_cents < 0 or p_received_cents > 100000000 then raise exception 'invalid_cash_amount'; end if;
  if coalesce(p_float_cents, 0) < 0 then raise exception 'invalid_cash_amount'; end if;
  select * into s from shifts where id = p_shift_id for update;
  if not found then raise exception 'unknown_shift'; end if;
  if s.status not in ('closing', 'pending_reconciliation') then raise exception 'shift_not_ready_for_cash'; end if;
  select * into cs from cash_settlements where shift_id = s.id for update;
  if found and cs.status in ('received', 'discrepancy', 'reconciled') then raise exception 'already_confirmed'; end if;
  select coalesce(sum(total_cents), 0)::int into expected
    from sales where shift_id = s.id and status = 'confirmed' and payment_method = 'cash';
  diff := p_received_cents - expected;
  st := case when diff = 0 then 'received' else 'discrepancy' end;
  insert into cash_settlements(shift_id, expected_cash_cents, received_cash_cents, cash_float_cents, adjustment_cents,
                               difference_cents, status, confirmed_by, confirmed_at, notes)
  values (s.id, expected, p_received_cents, coalesce(p_float_cents, 0), coalesce(p_adjustment_cents, 0),
          diff, st, auth.uid(), now(), p_notes)
  on conflict (shift_id) do update
    set expected_cash_cents = excluded.expected_cash_cents, received_cash_cents = excluded.received_cash_cents,
        cash_float_cents = excluded.cash_float_cents, adjustment_cents = excluded.adjustment_cents,
        difference_cents = excluded.difference_cents, status = excluded.status,
        confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at, notes = excluded.notes;
  perform _audit('admin', auth.uid()::text, 'cash_confirmed', 'shift', s.id::text,
                 jsonb_build_object('expected', expected, 'received', p_received_cents, 'difference', diff,
                                    'float', coalesce(p_float_cents, 0), 'adjustment', coalesce(p_adjustment_cents, 0)));
  return jsonb_build_object('expected_cash_cents', expected, 'received_cash_cents', p_received_cents,
                            'difference_cents', diff, 'status', st);
end $$;

create or replace function admin_acknowledge_cash(p_shift_id uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  if p_note is null or length(btrim(p_note)) < 3 then raise exception 'note_required'; end if;
  update cash_settlements set status = 'reconciled', ack_note = p_note
   where shift_id = p_shift_id and status = 'discrepancy';
  if not found then raise exception 'nothing_to_acknowledge'; end if;
  perform _audit('admin', auth.uid()::text, 'cash_discrepancy_acknowledged', 'shift', p_shift_id::text,
                 jsonb_build_object('note', p_note));
  return jsonb_build_object('status', 'reconciled');
end $$;

create or replace function admin_shift_closing_status(p_shift_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s shifts; blockers text[] := '{}'; review_n int; nonzero text; open_diff int; cs cash_settlements;
        sales_ok boolean; stock_ok boolean; cash_ok boolean;
begin
  perform _require_admin();
  select * into s from shifts where id = p_shift_id;
  if not found then raise exception 'unknown_shift'; end if;
  select count(*) into review_n from sales where shift_id = s.id and status = 'requires_review';
  select string_agg(p.name || ' (' || shift_balance(s.id, p.id) || ')', ', ') into nonzero
    from products p where shift_balance(s.id, p.id) <> 0;
  select count(*) into open_diff from stock_returns where shift_id = s.id and discrepancy_status = 'open';
  select * into cs from cash_settlements where shift_id = s.id;

  sales_ok := review_n = 0;
  stock_ok := nonzero is null and open_diff = 0;
  cash_ok := found and cs.status in ('received', 'reconciled');
  if s.status <> 'pending_reconciliation' and s.status <> 'closed' then blockers := array_append(blockers, ('shift_not_submitted')::text); end if;
  if not sales_ok then blockers := array_append(blockers, ((review_n || ' sale(s) need review'))::text); end if;
  if nonzero is not null then blockers := array_append(blockers, (('stock still held: ' || nonzero))::text); end if;
  if open_diff > 0 then blockers := array_append(blockers, ((open_diff || ' stock difference(s) not acknowledged'))::text); end if;
  if not cash_ok then blockers := array_append(blockers, ('cash handover not confirmed')::text); end if;
  return jsonb_build_object('shift_status', s.status, 'sales_sync', case when sales_ok then 'ok' else 'review' end,
    'stock_closing', case when stock_ok then 'ok' else 'pending' end,
    'cash_closing', coalesce(cs.status, 'not_declared'),
    'can_close', (cardinality(blockers) = 0 and s.status = 'pending_reconciliation'),
    'blockers', to_jsonb(blockers));
end $$;

create or replace function admin_close_shift(p_shift_id uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s shifts; st jsonb;
begin
  perform _require_admin();
  select * into s from shifts where id = p_shift_id for update;
  if not found then raise exception 'unknown_shift'; end if;
  if s.status = 'closed' then raise exception 'already_closed'; end if;
  st := admin_shift_closing_status(p_shift_id);
  if not (st->>'can_close')::boolean then
    raise exception 'closing_blocked: %', st->>'blockers';
  end if;
  update shifts set status = 'closed', closed_at = now(), closed_by = auth.uid(), close_note = p_note where id = s.id;
  perform _audit('admin', auth.uid()::text, 'shift_closed', 'shift', s.id::text, jsonb_build_object('note', p_note));
  return jsonb_build_object('status', 'closed');
end $$;

-- ======================================================================
-- ADMIN: dashboard + reports
-- ======================================================================
create or replace function admin_dashboard(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_date, business_date_now()); res jsonb;
begin
  perform _require_admin();
  select jsonb_build_object(
    'date', d,
    'generated_at', now(),
    'totals', (select jsonb_build_object(
        'revenue_cents', coalesce(sum(total_cents), 0),
        'cash_cents', coalesce(sum(total_cents) filter (where payment_method = 'cash'), 0),
        'qr_cents', coalesce(sum(total_cents) filter (where payment_method = 'duitnow_qr'), 0),
        'transactions', count(*),
        'units_sold', coalesce((select sum(si.quantity) from sale_items si join sales s2 on s2.id = si.sale_id
                                 where s2.business_date = d and s2.status = 'confirmed'), 0))
        from sales where business_date = d and status = 'confirmed'),
    'review_count', (select count(*) from sales where status = 'requires_review'),
    'active_shifts', (select count(*) from shifts where status in ('pending_allocation', 'active', 'closing')),
    'by_promoter', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('staff_id', st.id, 'name', st.name, 'revenue_cents', coalesce(sum(s.total_cents), 0),
                                  'cash_cents', coalesce(sum(s.total_cents) filter (where s.payment_method = 'cash'), 0),
                                  'qr_cents', coalesce(sum(s.total_cents) filter (where s.payment_method = 'duitnow_qr'), 0),
                                  'transactions', count(s.id)) as x
          from staff st join sales s on s.staff_id = st.id and s.business_date = d and s.status = 'confirmed'
         group by st.id, st.name) q), '[]'::jsonb),
    'by_product', coalesce((select jsonb_agg(x order by (x->>'units')::int desc) from (
        select jsonb_build_object('product_id', p.id, 'name', p.name, 'category', c.name,
                                  'units', sum(si.quantity), 'revenue_cents', sum(si.line_total_cents)) as x
          from sale_items si join sales s on s.id = si.sale_id and s.business_date = d and s.status = 'confirmed'
          join products p on p.id = si.product_id join categories c on c.id = p.category_id
         group by p.id, p.name, c.name) q), '[]'::jsonb),
    'by_category', coalesce((select jsonb_agg(x order by (x->>'revenue_cents')::int desc) from (
        select jsonb_build_object('category', c.name, 'units', sum(si.quantity), 'revenue_cents', sum(si.line_total_cents)) as x
          from sale_items si join sales s on s.id = si.sale_id and s.business_date = d and s.status = 'confirmed'
          join products p on p.id = si.product_id join categories c on c.id = p.category_id
         group by c.name) q), '[]'::jsonb),
    'trend', coalesce((select jsonb_agg(x order by x->>'date') from (
        select jsonb_build_object('date', business_date, 'revenue_cents', sum(total_cents), 'transactions', count(*)) as x
          from sales where status = 'confirmed' and business_date > d - 14 and business_date <= d
         group by business_date) q), '[]'::jsonb),
    'stock', coalesce((select jsonb_agg(x order by x->>'category', x->>'name') from (
        select jsonb_build_object('product_id', p.id, 'name', p.name, 'category', c.name,
                 'warehouse', warehouse_balance(p.id),
                 'allocated', coalesce((select sum(m.quantity_change) from stock_movements m
                                          join shifts sh on sh.id = m.shift_id
                                         where m.product_id = p.id and m.location = 'shift' and sh.status <> 'closed'), 0)) as x
          from products p join categories c on c.id = p.category_id where p.active) q), '[]'::jsonb),
    'pending_returns', (select count(*) from shifts where status in ('closing', 'pending_reconciliation')
                          and exists (select 1 from products p where shift_balance(shifts.id, p.id) > 0)),
    'open_stock_differences', (select count(*) from stock_returns where discrepancy_status = 'open'),
    'cash_status', coalesce((select jsonb_object_agg(status, n) from (
        select cs.status, count(*) as n from cash_settlements cs join shifts sh on sh.id = cs.shift_id
         where sh.business_date = d group by cs.status) q), '{}'::jsonb)
  ) into res;
  return res;
end $$;

create or replace function admin_report_sales(p_from date, p_to date)
returns table(business_date date, sale_number text, occurred_at timestamptz, promoter text, payment_method text,
              status text, subtotal_cents int, discount_cents int, total_cents int, items text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'invalid_range'; end if;
  return query
    select s.business_date, s.sale_number, s.occurred_at, st.name, s.payment_method, s.status,
           s.subtotal_cents, s.discount_cents, s.total_cents,
           (select string_agg(si.quantity || ' x ' || p.name, '; ' order by p.name)
              from sale_items si join products p on p.id = si.product_id where si.sale_id = s.id)
      from sales s join staff st on st.id = s.staff_id
     where s.business_date between p_from and p_to
     order by s.occurred_at;
end $$;

create or replace function admin_report_products(p_from date, p_to date)
returns table(business_date date, category text, product text, units bigint, revenue_cents bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'invalid_range'; end if;
  return query
    select s.business_date, c.name, p.name, sum(si.quantity)::bigint, sum(si.line_total_cents)::bigint
      from sale_items si join sales s on s.id = si.sale_id and s.status = 'confirmed'
      join products p on p.id = si.product_id join categories c on c.id = p.category_id
     where s.business_date between p_from and p_to
     group by s.business_date, c.name, p.name
     order by s.business_date, c.name, p.name;
end $$;

create or replace function admin_report_shifts(p_from date, p_to date)
returns table(business_date date, promoter text, shift_status text, started_at timestamptz, ended_at timestamptz,
              revenue_cents bigint, cash_expected_cents int, cash_declared_cents int, cash_received_cents int,
              cash_difference_cents int, cash_status text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'invalid_range'; end if;
  return query
    select sh.business_date, st.name, sh.status, sh.started_at, sh.ended_at,
           coalesce((select sum(s.total_cents) from sales s where s.shift_id = sh.id and s.status = 'confirmed'), 0)::bigint,
           cs.expected_cash_cents, cs.declared_cash_cents, cs.received_cash_cents, cs.difference_cents, cs.status
      from shifts sh join staff st on st.id = sh.staff_id left join cash_settlements cs on cs.shift_id = sh.id
     where sh.business_date between p_from and p_to
     order by sh.business_date, st.name;
end $$;
