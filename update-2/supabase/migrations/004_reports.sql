-- 004: end-of-shift report for promoters (PDF) and a simple daily total for administrators.
-- Safe to run once on top of 001-003.

create or replace function api_shift_report(p_shift_id uuid, p_hash text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s shifts; nm text;
begin
  s := _check_shift(p_shift_id, p_hash, false);
  select name into nm from staff where id = s.staff_id;
  return jsonb_build_object(
    'generated_at', now(),
    'staff_name', nm,
    'shift', _shift_json(s),
    'first_sale_at', (select min(occurred_at) from sales where shift_id = s.id and status <> 'voided'),
    'last_sale_at',  (select max(occurred_at) from sales where shift_id = s.id and status <> 'voided'),
    'totals', (select jsonb_build_object(
        'sales_count', count(*) filter (where status = 'confirmed'),
        'subtotal_cents', coalesce(sum(subtotal_cents) filter (where status = 'confirmed'), 0),
        'discount_cents', coalesce(sum(discount_cents) filter (where status = 'confirmed'), 0),
        'total_cents', coalesce(sum(total_cents) filter (where status = 'confirmed'), 0),
        'cash_cents', coalesce(sum(total_cents) filter (where status = 'confirmed' and payment_method = 'cash'), 0),
        'cash_count', count(*) filter (where status = 'confirmed' and payment_method = 'cash'),
        'qr_cents', coalesce(sum(total_cents) filter (where status = 'confirmed' and payment_method = 'duitnow_qr'), 0),
        'qr_count', count(*) filter (where status = 'confirmed' and payment_method = 'duitnow_qr'),
        'change_given_cents', coalesce(sum(change_cents) filter (where status = 'confirmed' and payment_method = 'cash'), 0),
        'review_count', count(*) filter (where status = 'requires_review'),
        'review_cents', coalesce(sum(total_cents) filter (where status = 'requires_review'), 0),
        'voided_count', count(*) filter (where status = 'voided'),
        'units_sold', coalesce((select sum(si.quantity) from sale_items si join sales x on x.id = si.sale_id
                                 where x.shift_id = s.id and x.status = 'confirmed'), 0))
        from sales where shift_id = s.id),
    'products', coalesce((
      select jsonb_agg(row order by row->>'category', row->>'name') from (
        select jsonb_build_object('name', p.name, 'category', c.name,
                 'received', coalesce(a.qty, 0), 'sold', coalesce(sd.qty, 0), 'sold_cents', coalesce(sd.cents, 0),
                 'expected_left', coalesce(ct.expected_quantity, shift_balance(s.id, p.id)),
                 'counted', ct.actual_quantity, 'difference', ct.difference) as row
          from products p join categories c on c.id = p.category_id
          left join (select product_id, sum(confirmed_quantity) as qty from stock_allocations
                      where shift_id = s.id and status = 'confirmed' group by product_id) a on a.product_id = p.id
          left join (select si.product_id, sum(si.quantity) as qty, sum(si.line_total_cents) as cents
                       from sale_items si join sales x on x.id = si.sale_id
                      where x.shift_id = s.id and x.status = 'confirmed' group by si.product_id) sd on sd.product_id = p.id
          left join stock_counts ct on ct.shift_id = s.id and ct.product_id = p.id
         where a.qty is not null or sd.qty is not null or ct.id is not null
      ) q), '[]'::jsonb),
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object('at', coalesce(sa.confirmed_at, sa.declared_at), 'product', p.name,
                 'declared', sa.declared_quantity, 'confirmed', sa.confirmed_quantity, 'status', sa.status)
             order by sa.declared_at, p.name)
        from stock_allocations sa join products p on p.id = sa.product_id where sa.shift_id = s.id), '[]'::jsonb),
    'sales', coalesce((
      select jsonb_agg(jsonb_build_object('number', x.sale_number, 'at', x.occurred_at, 'payment', x.payment_method,
                 'status', x.status, 'subtotal_cents', x.subtotal_cents, 'discount_cents', x.discount_cents,
                 'total_cents', x.total_cents, 'cash_received_cents', x.cash_received_cents, 'change_cents', x.change_cents,
                 'items', coalesce((select string_agg(si.quantity || ' x ' || p.name || case when si.promotion_id is not null then ' (promo)' else '' end, '; ' order by p.name)
                                      from sale_items si join products p on p.id = si.product_id where si.sale_id = x.id), ''))
             order by x.occurred_at)
        from sales x where x.shift_id = s.id), '[]'::jsonb),
    'cash', (select jsonb_build_object('expected_cents', cs.expected_cash_cents, 'declared_cents', cs.declared_cash_cents,
                      'received_cents', cs.received_cash_cents, 'difference_cents', cs.difference_cents, 'status', cs.status)
               from cash_settlements cs where cs.shift_id = s.id)
  );
end $$;

-- Administrator: one simple page for a business date.
create or replace function admin_daily_total(p_date date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := coalesce(p_date, business_date_now());
begin
  perform _require_admin();
  return jsonb_build_object(
    'date', d, 'generated_at', now(),
    'totals', (select jsonb_build_object(
        'sales_count', count(*) filter (where status = 'confirmed'),
        'discount_cents', coalesce(sum(discount_cents) filter (where status = 'confirmed'), 0),
        'total_cents', coalesce(sum(total_cents) filter (where status = 'confirmed'), 0),
        'cash_cents', coalesce(sum(total_cents) filter (where status = 'confirmed' and payment_method = 'cash'), 0),
        'qr_cents', coalesce(sum(total_cents) filter (where status = 'confirmed' and payment_method = 'duitnow_qr'), 0),
        'review_count', count(*) filter (where status = 'requires_review'),
        'units_sold', coalesce((select sum(si.quantity) from sale_items si join sales x on x.id = si.sale_id
                                 where x.business_date = d and x.status = 'confirmed'), 0))
        from sales where business_date = d),
    'products', coalesce((select jsonb_agg(r order by r->>'category', r->>'name') from (
        select jsonb_build_object('name', p.name, 'category', c.name,
                 'sold', coalesce(sd.qty, 0), 'sold_cents', coalesce(sd.cents, 0),
                 'warehouse_left', warehouse_balance(p.id),
                 'with_promoters', coalesce((select sum(m.quantity_change) from stock_movements m join shifts sh on sh.id = m.shift_id
                                              where m.product_id = p.id and m.location = 'shift' and sh.status <> 'closed'), 0)) as r
          from products p join categories c on c.id = p.category_id
          left join (select si.product_id, sum(si.quantity) as qty, sum(si.line_total_cents) as cents
                       from sale_items si join sales x on x.id = si.sale_id
                      where x.business_date = d and x.status = 'confirmed' group by si.product_id) sd on sd.product_id = p.id
         where p.active or sd.qty is not null) q), '[]'::jsonb),
    'promoters', coalesce((select jsonb_agg(r order by r->>'name') from (
        select jsonb_build_object('name', st.name, 'shift_status', sh.status,
                 'sales_count', (select count(*) from sales x where x.shift_id = sh.id and x.status = 'confirmed'),
                 'total_cents', coalesce((select sum(total_cents) from sales x where x.shift_id = sh.id and x.status = 'confirmed'), 0),
                 'cash_cents', coalesce((select sum(total_cents) from sales x where x.shift_id = sh.id and x.status = 'confirmed' and x.payment_method = 'cash'), 0),
                 'qr_cents', coalesce((select sum(total_cents) from sales x where x.shift_id = sh.id and x.status = 'confirmed' and x.payment_method = 'duitnow_qr'), 0),
                 'cash_declared_cents', cs.declared_cash_cents, 'cash_received_cents', cs.received_cash_cents, 'cash_status', cs.status) as r
          from shifts sh join staff st on st.id = sh.staff_id left join cash_settlements cs on cs.shift_id = sh.id
         where sh.business_date = d) q), '[]'::jsonb));
end $$;

revoke execute on function api_shift_report(uuid, text), admin_daily_total(date) from public, anon, authenticated;
grant  execute on function api_shift_report(uuid, text) to service_role;
grant  execute on function admin_daily_total(date) to authenticated, service_role;
