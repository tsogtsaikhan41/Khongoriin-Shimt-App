-- ХОНГОРЫН ШИМТ V6
-- Paste this entire file into Supabase SQL Editor and run once.
-- IMPORTANT: never put a Supabase service-role key in the frontend.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  role text not null default 'admin' check (role in ('admin','superadmin')),
  soum text,
  created_at timestamptz not null default now()
);
-- Assigned working location. When set on a non-superadmin, the purchase form
-- locks the soum field to this value so an admin cannot record an animal
-- against the wrong soum. Superadmin (and anyone with soum null) may choose.
alter table public.profiles add column if not exists soum text;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public
as $$ begin
  insert into public.profiles(id,full_name,role) values(new.id,coalesce(new.raw_user_meta_data->>'full_name',split_part(new.email,'@',1)),'admin') on conflict(id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create table if not exists public.herders (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  soum text not null,
  location_detail text,
  herd_size numeric,
  last_vaccination_date date,
  certified boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.animals (
  id uuid primary key default gen_random_uuid(),
  animal_code text not null unique,
  herder_id uuid not null references public.herders(id),
  soum text not null,
  purchase_date date not null,
  animal_type text not null,
  estimated_age_years numeric,
  live_weight_kg numeric not null check (live_weight_kg > 0),
  price_per_kg numeric not null default 0 check (price_per_kg >= 0),
  total_cost numeric not null default 0 check (total_cost >= 0),
  status text not null default 'PURCHASED',
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.processing_events (
  id uuid primary key default gen_random_uuid(),
  animal_id uuid not null unique references public.animals(id),
  processing_date date not null,
  location text,
  responsible_user uuid references auth.users(id),
  processing_cost numeric not null default 0 check (processing_cost >= 0),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.material_lots (
  id uuid primary key default gen_random_uuid(),
  animal_id uuid not null references public.animals(id),
  source_processing_id uuid references public.processing_events(id),
  parent_lot_id uuid references public.material_lots(id),
  material_type text not null check (material_type in ('MEAT','BYPRODUCT')),
  original_quantity_kg numeric not null check (original_quantity_kg > 0),
  location_type text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null,
  quantity_delta_kg numeric not null,
  movement_type text not null,
  location_type text not null,
  related_entity_type text,
  related_entity_id uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint inventory_movements_lot_fk foreign key (lot_id) references public.material_lots(id) on delete restrict
);

create table if not exists public.transports (
  id uuid primary key default gen_random_uuid(),
  transport_date date not null,
  source_location text not null,
  destination_location text not null default 'SHOP',
  responsible_user uuid references auth.users(id),
  cost numeric not null default 0 check (cost >= 0),
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.transport_items (
  id uuid primary key default gen_random_uuid(),
  transport_id uuid not null references public.transports(id) on delete restrict,
  source_material_id uuid not null references public.material_lots(id),
  animal_id uuid not null references public.animals(id),
  quantity_sent_kg numeric not null check (quantity_sent_kg > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.receivings (
  id uuid primary key default gen_random_uuid(),
  transport_item_id uuid not null unique references public.transport_items(id) on delete restrict,
  received_date date not null,
  received_weight_kg numeric not null check (received_weight_kg >= 0),
  note text,
  responsible_user uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  product_code text not null unique,
  animal_id uuid not null references public.animals(id),
  source_material_id uuid references public.material_lots(id),
  product_type text not null,
  weight_kg numeric not null check (weight_kg > 0),
  unit text not null,
  qty numeric not null default 1 check (qty > 0),
  unit_weight_kg numeric,
  packaging_date date not null,
  packaging_cost numeric not null default 0 check (packaging_cost >= 0),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.product_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  quantity_delta_kg numeric not null,
  movement_type text not null,
  location_type text not null,
  related_entity_type text,
  related_entity_id uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  qty numeric not null check (qty > 0),
  unit_price numeric not null check (unit_price >= 0),
  total_amount numeric not null check (total_amount >= 0),
  sale_date date not null,
  customer text,
  customer_phone text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  user_id uuid references auth.users(id),
  old_data jsonb,
  new_data jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_animals_herder on public.animals(herder_id);
create index if not exists idx_material_lots_animal on public.material_lots(animal_id);
create index if not exists idx_material_lots_parent on public.material_lots(parent_lot_id);
create index if not exists idx_inventory_movements_lot on public.inventory_movements(lot_id);
create index if not exists idx_product_movements_product on public.product_movements(product_id);
create index if not exists idx_transport_items_transport on public.transport_items(transport_id);
create index if not exists idx_sales_product on public.sales(product_id);
create index if not exists idx_audit_created on public.audit_logs(created_at desc);

-- Helper functions
create or replace function public.is_superadmin()
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='superadmin') $$;

create or replace function public.is_admin_or_superadmin()
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from public.profiles p where p.id=auth.uid() and p.role in ('admin','superadmin')) $$;

-- Simple audit trigger for operational tables.
create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  if TG_OP='INSERT' then
    insert into public.audit_logs(entity_type,entity_id,action,user_id,new_data)
    values(TG_TABLE_NAME,NEW.id,'CREATE',auth.uid(),to_jsonb(NEW));
    return NEW;
  elsif TG_OP='UPDATE' then
    insert into public.audit_logs(entity_type,entity_id,action,user_id,old_data,new_data)
    values(TG_TABLE_NAME,NEW.id,'UPDATE',auth.uid(),to_jsonb(OLD),to_jsonb(NEW));
    return NEW;
  elsif TG_OP='DELETE' then
    insert into public.audit_logs(entity_type,entity_id,action,user_id,old_data)
    values(TG_TABLE_NAME,OLD.id,'DELETE',auth.uid(),to_jsonb(OLD));
    return OLD;
  end if;
  return null;
end $$;

drop trigger if exists trg_audit_herders on public.herders;
create trigger trg_audit_herders after insert or update or delete on public.herders for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_animals on public.animals;
create trigger trg_audit_animals after insert or update or delete on public.animals for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_processing on public.processing_events;
create trigger trg_audit_processing after insert or update or delete on public.processing_events for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_transports on public.transports;
create trigger trg_audit_transports after insert or update or delete on public.transports for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_transport_items on public.transport_items;
create trigger trg_audit_transport_items after insert or update or delete on public.transport_items for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_receivings on public.receivings;
create trigger trg_audit_receivings after insert or update or delete on public.receivings for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_products on public.products;
create trigger trg_audit_products after insert or update or delete on public.products for each row execute function public.audit_row_change();
drop trigger if exists trg_audit_sales on public.sales;
create trigger trg_audit_sales after insert or update or delete on public.sales for each row execute function public.audit_row_change();

-- Material balances. A lot can have one logical stream of quantities; transport creates a child lot at destination.
create or replace view public.materials as
select
  ml.id, ml.animal_id, a.animal_code, a.animal_type, ml.source_processing_id, ml.parent_lot_id,
  ml.material_type, ml.original_quantity_kg, ml.location_type,
  coalesce(sum(im.quantity_delta_kg),0) as current_available,
  ml.created_at
from public.material_lots ml
join public.animals a on a.id=ml.animal_id
left join public.inventory_movements im on im.lot_id=ml.id
group by ml.id,a.animal_code,a.animal_type,ml.source_processing_id,ml.parent_lot_id,ml.material_type,ml.original_quantity_kg,ml.location_type,ml.created_at;

create or replace view public.transport_summary as
select t.*,coalesce(sum(ti.quantity_sent_kg),0) total_sent_kg
from public.transports t left join public.transport_items ti on ti.transport_id=t.id
group by t.id;

create or replace view public.product_balances as
select
 p.*, a.animal_code, a.animal_type,
 coalesce(sum(pm.quantity_delta_kg),0) as current_available
from public.products p join public.animals a on a.id=p.animal_id
left join public.product_movements pm on pm.product_id=p.id
group by p.id,a.animal_code,a.animal_type;

-- Public QR-safe view. No costs, customers, staff, IDs or internal notes.
--
-- PRIVACY: herders are private individuals who have not consented to having
-- their full legal name published permanently on the open internet. We publish
-- a shortened display name only: first name plus the initial of the next word.
--   "Дондов Батэрдэнэ" -> "Дондов Б."
--   "Батбаяр"          -> "Батбаяр"
-- Never exposed publicly: full legal name, herd size, exact location/bagh,
-- any cost, any price, staff names, customers, internal UUIDs, notes.
create or replace view public.public_products as
select
  p.product_code,
  p.product_type,
  a.animal_type,
  a.estimated_age_years,
  pe.processing_date,
  p.packaging_date,
  case
    when position(' ' in btrim(h.full_name)) > 0
      then split_part(btrim(h.full_name), ' ', 1) || ' ' ||
           upper(left(split_part(btrim(h.full_name), ' ', 2), 1)) || '.'
    else btrim(h.full_name)
  end as herder_name,
  h.soum,
  h.certified
from public.products p
join public.animals a on a.id=p.animal_id
join public.herders h on h.id=a.herder_id
left join public.processing_events pe on pe.animal_id=a.id;

grant select on public.public_products to anon, authenticated;

-- Atomic processing bundle.
create or replace function public.create_processing_bundle(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare
  pr jsonb := p_payload->'processing';
  outs jsonb := p_payload->'outputs';
  aid uuid := (pr->>'animal_id')::uuid;
  pid uuid := (pr->>'id')::uuid;
  o jsonb; lot_id uuid; count_outputs int := 0;
  animal_record public.animals%rowtype;
  source_soum text;
begin
  if not public.is_admin_or_superadmin() then raise exception 'FORBIDDEN'; end if;
  select * into animal_record from public.animals where id=aid for update;
  if not found then raise exception 'ANIMAL_NOT_FOUND'; end if;
  if exists(select 1 from public.processing_events where id=pid) then
    return jsonb_build_object('processing_id',pid,'idempotent',true);
  end if;
  if animal_record.status <> 'PURCHASED' then raise exception 'ANIMAL_ALREADY_PROCESSED'; end if;
  if exists(select 1 from public.processing_events where animal_id=aid) then raise exception 'ANIMAL_ALREADY_PROCESSED'; end if;

  insert into public.processing_events(id,animal_id,processing_date,location,responsible_user,processing_cost,note)
  values(pid,aid,(pr->>'processing_date')::date,nullif(pr->>'location',''),auth.uid(),coalesce((pr->>'processing_cost')::numeric,0),pr->>'note');

  source_soum := animal_record.soum;
  for o in select * from jsonb_array_elements(outs) loop
    if coalesce((o->>'quantity_kg')::numeric,0) <= 0 then continue; end if;
    lot_id := (o->>'id')::uuid;
    insert into public.material_lots(id,animal_id,source_processing_id,material_type,original_quantity_kg,location_type)
    values(lot_id,aid,pid,o->>'material_type',(o->>'quantity_kg')::numeric,source_soum);
    insert into public.inventory_movements(lot_id,quantity_delta_kg,movement_type,location_type,related_entity_type,related_entity_id,created_by)
    values(lot_id,(o->>'quantity_kg')::numeric,'PROCESSING_OUTPUT',source_soum,'processing',pid,auth.uid());
    count_outputs := count_outputs + 1;
  end loop;
  if count_outputs=0 then raise exception 'NO_OUTPUTS'; end if;

  update public.animals set status='PROCESSED',updated_at=now() where id=aid;
  return jsonb_build_object('processing_id',pid);
end $$;

-- Atomic transport bundle. Each item consumes source material immediately.
create or replace function public.create_transport_bundle(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public
as $$
declare
  tr jsonb := p_payload->'transport';
  items jsonb := p_payload->'items';
  tid uuid := (tr->>'id')::uuid;
  i jsonb; mid uuid; aid uuid; q numeric; available numeric;
  source_location text;
begin
  if not public.is_admin_or_superadmin() then raise exception 'FORBIDDEN'; end if;
  if exists(select 1 from public.transports where id=tid) then return jsonb_build_object('transport_id',tid,'idempotent',true); end if;
  insert into public.transports(id,transport_date,source_location,destination_location,responsible_user,cost,note)
  values(tid,(tr->>'transport_date')::date,tr->>'source_location',coalesce(tr->>'destination_location','SHOP'),(tr->>'responsible_user')::uuid,coalesce((tr->>'cost')::numeric,0),tr->>'note');
  for i in select * from jsonb_array_elements(items) loop
    mid := (i->>'source_material_id')::uuid;
    aid := (i->>'animal_id')::uuid;
    q := (i->>'quantity_sent_kg')::numeric;
    select ml.location_type into source_location from public.material_lots ml where ml.id=mid for update;
    if source_location is null then raise exception 'MATERIAL_NOT_FOUND'; end if;
    select coalesce(sum(quantity_delta_kg),0) into available from public.inventory_movements where lot_id=mid;
    if available < q then raise exception 'INSUFFICIENT_MATERIAL:%:%',mid,available; end if;
    if source_location='SHOP' then raise exception 'SOURCE_ALREADY_SHOP'; end if;
    insert into public.transport_items(id,transport_id,source_material_id,animal_id,quantity_sent_kg)
    values((i->>'id')::uuid,tid,mid,aid,q);
    insert into public.inventory_movements(lot_id,quantity_delta_kg,movement_type,location_type,related_entity_type,related_entity_id,created_by)
    values(mid,-q,'TRANSPORT_OUT',source_location,'transport',tid,auth.uid());
  end loop;
  return jsonb_build_object('transport_id',tid);
end $$;

-- Receiving creates a new destination lot, preserving the original animal lineage.
create or replace function public.receive_transport(
  p_transport_id uuid,
  p_received_date date,
  p_note text,
  p_user_id uuid,
  p_received_weight_kg numeric
) returns jsonb language plpgsql security definer set search_path=public
as $$
declare
  ti public.transport_items%rowtype;
  existing public.receivings%rowtype;
  src public.material_lots%rowtype;
  new_lot uuid;
  receiving_id uuid;
  sent numeric;
begin
  if not public.is_admin_or_superadmin() then raise exception 'FORBIDDEN'; end if;
  select * into ti from public.transport_items where transport_id=p_transport_id limit 1 for update;
  if not found then raise exception 'TRANSPORT_NOT_FOUND'; end if;
  select * into existing from public.receivings where transport_item_id=ti.id;
  if found then return jsonb_build_object('receiving_id',existing.id,'idempotent',true); end if;
  if p_received_weight_kg < 0 then raise exception 'INVALID_WEIGHT'; end if;
  sent := ti.quantity_sent_kg;
  select * into src from public.material_lots where id=ti.source_material_id;
  if not found then raise exception 'SOURCE_NOT_FOUND'; end if;

  receiving_id := gen_random_uuid();
  insert into public.receivings(id,transport_item_id,received_date,received_weight_kg,note,responsible_user)
  values(receiving_id,ti.id,p_received_date,p_received_weight_kg,p_note,p_user_id);

  new_lot := gen_random_uuid();
  insert into public.material_lots(id,animal_id,parent_lot_id,material_type,original_quantity_kg,location_type)
  values(new_lot,ti.animal_id,ti.source_material_id,src.material_type,p_received_weight_kg,'SHOP');
  insert into public.inventory_movements(lot_id,quantity_delta_kg,movement_type,location_type,related_entity_type,related_entity_id,created_by)
  values(new_lot,p_received_weight_kg,'RECEIVING_IN','SHOP','receiving',receiving_id,auth.uid());

  return jsonb_build_object('receiving_id',receiving_id,'material_id',new_lot,'difference',sent-p_received_weight_kg);
end $$;

-- Atomic product creation. One source lot -> one product, same animal lineage.
create or replace function public.create_product(
  p_product_id uuid,
  p_product_code text,
  p_material_id uuid,
  p_weight_kg numeric,
  p_product_type text,
  p_packaging_date date,
  p_packaging_cost numeric,
  p_note text,
  p_qty numeric,
  p_unit text,
  p_unit_weight_kg numeric,
  p_user_id uuid
) returns jsonb language plpgsql security definer set search_path=public
as $$
declare
  m public.material_lots%rowtype;
  available numeric;
  product_id uuid := p_product_id;
  code text := p_product_code;
begin
  if not public.is_admin_or_superadmin() then raise exception 'FORBIDDEN'; end if;
  if exists(select 1 from public.products where id=product_id) then return jsonb_build_object('product_id',product_id,'product_code',p_product_code,'idempotent',true); end if;
  select * into m from public.material_lots where id=p_material_id for update;
  if not found then raise exception 'MATERIAL_NOT_FOUND'; end if;
  if m.location_type <> 'SHOP' then raise exception 'MATERIAL_NOT_AT_SHOP'; end if;
  select coalesce(sum(quantity_delta_kg),0) into available from public.inventory_movements where lot_id=p_material_id;
  if p_weight_kg <= 0 or p_weight_kg > available then raise exception 'INSUFFICIENT_MATERIAL:%',available; end if;

  if code is null or length(trim(code))=0 then code := (select a.animal_code from public.animals a where a.id=m.animal_id) || '-P' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)); end if;
  insert into public.products(id,product_code,animal_id,source_material_id,product_type,weight_kg,unit,qty,unit_weight_kg,packaging_date,packaging_cost,note,created_by)
  values(product_id,code,m.animal_id,p_material_id,p_product_type,p_weight_kg,p_unit,p_qty,p_unit_weight_kg,p_packaging_date,p_packaging_cost,p_note,p_user_id);
  insert into public.inventory_movements(lot_id,quantity_delta_kg,movement_type,location_type,related_entity_type,related_entity_id,created_by)
  values(p_material_id,-p_weight_kg,'PRODUCT_INPUT','SHOP','product',product_id,p_user_id);
  insert into public.product_movements(product_id,quantity_delta_kg,movement_type,location_type,created_by)
  values(product_id,p_weight_kg,'PRODUCT_CREATED','SHOP',p_user_id);
  return jsonb_build_object('product_id',product_id,'product_code',code);
end $$;

-- Atomic sale with row lock. Server validates actual availability at commit time.
create or replace function public.create_sale(
  p_sale_id uuid,
  p_product_id uuid,
  p_qty numeric,
  p_unit_price numeric,
  p_sale_date date,
  p_customer text,
  p_customer_phone text,
  p_user_id uuid
) returns jsonb language plpgsql security definer set search_path=public
as $$
declare
  p public.products%rowtype;
  available numeric;
  sid uuid := p_sale_id;
begin
  if not public.is_admin_or_superadmin() then raise exception 'FORBIDDEN'; end if;
  if exists(select 1 from public.sales where id=sid) then return jsonb_build_object('sale_id',sid,'idempotent',true); end if;
  select * into p from public.products where id=p_product_id for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  select coalesce(sum(quantity_delta_kg),0) into available from public.product_movements where product_id=p_product_id;
  if p_qty <= 0 or p_qty > available then raise exception 'INSUFFICIENT_PRODUCT:%',available; end if;
  insert into public.sales(id,product_id,qty,unit_price,total_amount,sale_date,customer,customer_phone,created_by)
  values(sid,p_product_id,p_qty,p_unit_price,p_qty*p_unit_price,p_sale_date,p_customer,p_customer_phone,p_user_id);
  insert into public.product_movements(product_id,quantity_delta_kg,movement_type,location_type,related_entity_type,related_entity_id,created_by)
  values(p_product_id,-p_qty,'SALE','SHOP','sale',sid,p_user_id);
  return jsonb_build_object('sale_id',sid);
end $$;

-- Correctness: no operation can consume more than a source lot. Server functions above use row locks.
-- Ordinary delete/update on operational tables is disabled by RLS; Superadmin may update.

-- RLS
alter table public.profiles enable row level security;
alter table public.herders enable row level security;
alter table public.animals enable row level security;
alter table public.processing_events enable row level security;
alter table public.material_lots enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.transports enable row level security;
alter table public.transport_items enable row level security;
alter table public.receivings enable row level security;
alter table public.products enable row level security;
alter table public.product_movements enable row level security;
alter table public.sales enable row level security;
alter table public.audit_logs enable row level security;

-- Drop common policies first for idempotent re-runs.
do $$declare r record; begin
  for r in select schemaname,tablename,policyname from pg_policies where schemaname='public' and tablename in ('profiles','herders','animals','processing_events','material_lots','inventory_movements','transports','transport_items','receivings','products','product_movements','sales','audit_logs') loop
    execute format('drop policy if exists %I on %I.%I',r.policyname,r.schemaname,r.tablename);
  end loop;
end$$;

create policy profiles_self on public.profiles for select to authenticated using (id=auth.uid() or public.is_superadmin());
create policy profiles_superadmin_write on public.profiles for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

create policy herders_read on public.herders for select to authenticated using (public.is_admin_or_superadmin());
create policy herders_insert on public.herders for insert to authenticated with check (public.is_admin_or_superadmin());
create policy herders_update on public.herders for update to authenticated using (public.is_admin_or_superadmin()) with check (public.is_admin_or_superadmin());

create policy animals_read on public.animals for select to authenticated using (public.is_admin_or_superadmin());
create policy animals_insert on public.animals for insert to authenticated with check (public.is_admin_or_superadmin());
create policy animals_update_super on public.animals for update to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

create policy processing_read on public.processing_events for select to authenticated using (public.is_admin_or_superadmin());
create policy processing_super_update on public.processing_events for update to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

create policy material_lots_read on public.material_lots for select to authenticated using (public.is_admin_or_superadmin());
create policy inventory_read on public.inventory_movements for select to authenticated using (public.is_admin_or_superadmin());

create policy transports_read on public.transports for select to authenticated using (public.is_admin_or_superadmin());
create policy transports_super_update on public.transports for update to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
create policy transport_items_read on public.transport_items for select to authenticated using (public.is_admin_or_superadmin());
create policy receiving_read on public.receivings for select to authenticated using (public.is_admin_or_superadmin());
create policy receiving_super_update on public.receivings for update to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

create policy products_read on public.products for select to authenticated using (public.is_admin_or_superadmin());
create policy products_super_update on public.products for update to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
create policy product_movements_read on public.product_movements for select to authenticated using (public.is_admin_or_superadmin());
create policy sales_read on public.sales for select to authenticated using (public.is_admin_or_superadmin());
create policy sales_super_update on public.sales for update to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
create policy audit_read on public.audit_logs for select to authenticated using (public.is_superadmin());

-- No delete policies for operational data: ordinary users and Superadmins cannot hard-delete through the API.
-- Corrections should be UPDATEs so audit history can preserve old/new values.

-- Ensure function execute permissions are explicit.
grant execute on function public.create_processing_bundle(jsonb) to authenticated;
grant execute on function public.create_transport_bundle(jsonb) to authenticated;
grant execute on function public.receive_transport(uuid,date,text,uuid,numeric) to authenticated;
grant execute on function public.create_product(uuid,text,uuid,numeric,text,date,numeric,text,numeric,text,numeric,uuid) to authenticated;
grant execute on function public.create_sale(uuid,uuid,numeric,numeric,date,text,text,uuid) to authenticated;

-- Public QR lookup is intentionally limited to the safe view.
-- If Supabase PostgREST does not expose the view immediately, reload the API schema cache in project settings.
