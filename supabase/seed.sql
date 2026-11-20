-- Seed data taken from the existing Christmas Sales Recorder page.
-- Run once, after the migrations. Promoters (staff) are NOT seeded - add them in the admin Settings tab.
insert into categories(name, sort_order) values ('Pepsi', 1) on conflict (name) do nothing;

insert into products(name, category_id, price_cents, sort_order)
select v.name, c.id, v.price, v.ord
  from (values
    ('Pepsi', 200, 1), ('Pepsi Black', 200, 2), ('M.Dew', 200, 3), ('Revive', 200, 4), ('7-Up', 200, 5),
    ('Calpis S. Grape', 300, 6), ('Calpis S. Ori', 300, 7),
    ('Twister 355ml Orange', 350, 8), ('Twister 355ml Apple', 350, 9), ('Twister 355ml BC', 350, 10),
    ('Lipton SD Lemon', 350, 11), ('Lipton SD Berry', 350, 12),
    ('Wonda Ori', 300, 13), ('Wonda Tarik', 300, 14)
  ) as v(name, price, ord)
  join categories c on c.name = 'Pepsi'
on conflict (name) do nothing;

-- Buy 5 Get 1: six drinks for RM 10.00.
-- ASSUMPTION (to be confirmed by the business): every product in the Pepsi category is eligible.
-- Change the eligibility any time by editing promotions.configuration.
insert into promotions(name, promotion_type, promotional_price_cents, configuration)
select 'Buy 5 Get 1', 'bundle_price', 1000,
       jsonb_build_object('bundle_size', 6, 'eligible_category_ids', jsonb_build_array(c.id))
  from categories c where c.name = 'Pepsi'
   and not exists (select 1 from promotions where name = 'Buy 5 Get 1');
