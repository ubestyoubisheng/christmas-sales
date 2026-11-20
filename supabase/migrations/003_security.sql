-- Christmas Sales Recorder - Row Level Security, privileges, audit triggers, realtime.
-- Principle: browsers (anon key) can do NOTHING directly. Signed-in administrators can READ everything
-- (needed for the live dashboard) and can only CHANGE data through the admin_* functions, except the
-- catalogue tables (staff, categories, products, promotions) which the owner may edit directly (audited).

alter table staff             enable row level security;
alter table admins            enable row level security;
alter table categories        enable row level security;
alter table products          enable row level security;
alter table promotions        enable row level security;
alter table shifts            enable row level security;
alter table stock_allocations enable row level security;
alter table sales             enable row level security;
alter table sale_items        enable row level security;
alter table stock_movements   enable row level security;
alter table stock_counts      enable row level security;
alter table stock_returns     enable row level security;
alter table cash_settlements  enable row level security;
alter table audit_logs        enable row level security;

create policy admin_read on staff             for select to authenticated using (is_admin());
create policy admin_read on categories        for select to authenticated using (is_admin());
create policy admin_read on products          for select to authenticated using (is_admin());
create policy admin_read on promotions        for select to authenticated using (is_admin());
create policy admin_read on shifts            for select to authenticated using (is_admin());
create policy admin_read on stock_allocations for select to authenticated using (is_admin());
create policy admin_read on sales             for select to authenticated using (is_admin());
create policy admin_read on sale_items        for select to authenticated using (is_admin());
create policy admin_read on stock_movements   for select to authenticated using (is_admin());
create policy admin_read on stock_counts      for select to authenticated using (is_admin());
create policy admin_read on stock_returns     for select to authenticated using (is_admin());
create policy admin_read on cash_settlements  for select to authenticated using (is_admin());
create policy admin_read on audit_logs        for select to authenticated using (is_admin());
create policy own_row    on admins            for select to authenticated using (user_id = auth.uid());

create policy owner_write on staff      for all to authenticated using (is_owner()) with check (is_owner());
create policy owner_write on categories for all to authenticated using (is_owner()) with check (is_owner());
create policy owner_write on products   for all to authenticated using (is_owner()) with check (is_owner());
create policy owner_write on promotions for all to authenticated using (is_owner()) with check (is_owner());

-- table privileges
revoke all on all tables    in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
grant select on staff, admins, categories, products, promotions, shifts, stock_allocations, sales, sale_items,
                stock_movements, stock_counts, stock_returns, cash_settlements, audit_logs to authenticated;
grant insert, update, delete on staff, categories, products, promotions to authenticated;
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- function privileges: nothing is executable by default
revoke execute on all functions in schema public from public, anon, authenticated;
grant  execute on all functions in schema public to service_role;
grant  execute on function is_admin(), is_owner(), business_date_now() to authenticated;
grant  execute on function
  admin_record_receipt(uuid, int, text), admin_adjust_warehouse(uuid, int, text),
  admin_confirm_allocation(uuid, jsonb), admin_allocate_stock(uuid, uuid, int, text),
  admin_resolve_sale(uuid, text, text), admin_void_sale(uuid, text),
  admin_confirm_return(uuid, jsonb), admin_acknowledge_stock_difference(uuid, uuid, text, boolean),
  admin_confirm_cash(uuid, int, int, int, text), admin_acknowledge_cash(uuid, text),
  admin_shift_closing_status(uuid), admin_close_shift(uuid, text),
  admin_dashboard(date), admin_report_sales(date, date), admin_report_products(date, date),
  admin_report_shifts(date, date)
  to authenticated;

-- audit trail for catalogue edits made directly by the owner
create or replace function _log_config_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_logs(actor_type, actor_id, action, entity_type, entity_id, details)
  values ('admin', auth.uid()::text, lower(tg_op) || '_' || tg_table_name, tg_table_name,
          (case when tg_op = 'DELETE' then old.id else new.id end)::text,
          jsonb_build_object('old', case when tg_op <> 'INSERT' then to_jsonb(old) end,
                             'new', case when tg_op <> 'DELETE' then to_jsonb(new) end));
  return null;
end $$;
revoke execute on function _log_config_change() from public, anon, authenticated;

create trigger staff_audit      after insert or update or delete on staff      for each row execute function _log_config_change();
create trigger categories_audit after insert or update or delete on categories for each row execute function _log_config_change();
create trigger products_audit   after insert or update or delete on products   for each row execute function _log_config_change();
create trigger promotions_audit after insert or update or delete on promotions for each row execute function _log_config_change();

-- live dashboard (Supabase Realtime respects RLS, so only administrators receive these events)
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table sales, shifts, stock_allocations, stock_returns, cash_settlements;
  end if;
end $$;
