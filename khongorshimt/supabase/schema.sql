-- ============================================================
-- Khongoriin Shimt -- Livestock Tracking System
-- Supabase schema. Run this once in Supabase SQL Editor.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- PROFILES ----------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  role text not null check (role in ('admin','staff')),
  created_at timestamptz default now()
);

-- helper: is the current user an admin? (security definer avoids RLS recursion)
create or replace function is_admin()
returns boolean
language sql security definer stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------- ANIMALS (per-animal purchase + lifecycle) ----------
create table animals (
  id uuid primary key default gen_random_uuid(),
  animal_code text unique not null,
  soum text not null,
  purchase_date date not null,
  herder_name text not null,
  animal_type text not null,
  live_weight_kg numeric not null,
  price_per_kg numeric not null,
  total_cost numeric not null,
  purchasing_agent text not null,
  note text,
  status text not null default 'purchased'
    check (status in ('purchased','slaughtered','transported','received','packaged','sold_out')),
  created_by uuid references profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table batch_counters (
  key text primary key,
  seq int not null default 0
);

-- ---------- SLAUGHTER (bundled session, per-animal detail) ----------
create table slaughter_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  location text,
  total_cost numeric not null,
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

create table slaughter_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references slaughter_sessions(id) on delete cascade,
  animal_id uuid unique references animals(id),
  carcass_weight_kg numeric not null,
  cost_share numeric not null,
  yield_pct numeric
);

-- ---------- TRANSPORT (bundled session, per-animal cost share) ----------
create table transport_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  total_cost numeric not null,
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

create table transport_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid references transport_sessions(id) on delete cascade,
  animal_id uuid unique references animals(id),
  weight_sent_kg numeric not null,
  cost_share numeric not null
);

-- ---------- RECEIVING (aggregate weight/loss per transport session) ----------
create table receiving_sessions (
  id uuid primary key default gen_random_uuid(),
  transport_session_id uuid references transport_sessions(id),
  received_date date not null,
  total_weight_received numeric not null,
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- ---------- PACKAGING ----------
create table packagings (
  id uuid primary key default gen_random_uuid(),
  animal_id uuid references animals(id),
  receiving_session_id uuid references receiving_sessions(id),
  source_packaging_id uuid references packagings(id),
  product_type text not null,
  weight_kg numeric not null,
  unit text not null,
  qty numeric not null,
  packaging_date date not null,
  packaging_cost numeric not null,
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- ---------- SALES ----------
create table sales (
  id uuid primary key default gen_random_uuid(),
  packaging_id uuid references packagings(id),
  qty numeric not null,
  unit_price numeric not null,
  total numeric not null,
  sale_date date not null,
  customer_name text,
  customer_phone text,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- atomic "give me the next sequence number for this key" --
-- used to build animal codes like BOG-260314-BAY-001 without
-- race conditions when two people save at once while online.
create or replace function next_seq(p_key text)
returns int
language plpgsql security definer
as $$
declare v_seq int;
begin
  insert into batch_counters(key, seq) values (p_key, 1)
    on conflict (key) do update set seq = batch_counters.seq + 1
    returning seq into v_seq;
  return v_seq;
end;
$$;

-- ============================================================
-- ROW LEVEL SECURITY
-- Read: any logged-in user. Insert: any logged-in user (form
-- availability is enforced in the app UI). Update: admin only
-- (this is how "fix a mistake" works). Delete: nobody -- no
-- delete policy exists on purpose.
-- ============================================================

alter table profiles enable row level security;
alter table animals enable row level security;
alter table batch_counters enable row level security;
alter table slaughter_sessions enable row level security;
alter table slaughter_items enable row level security;
alter table transport_sessions enable row level security;
alter table transport_items enable row level security;
alter table receiving_sessions enable row level security;
alter table packagings enable row level security;
alter table sales enable row level security;

-- profiles
-- public (even logged-out) select is intentional: the app needs to
-- check "does any profile exist yet?" before anyone has logged in,
-- to decide whether to show first-run setup or the login screen.
-- profiles has no secrets (passwords live in auth.users, not here).
create policy "profiles_select_all" on profiles for select using (true);
create policy "profiles_insert_self" on profiles for insert with check (id = auth.uid());
create policy "profiles_update_admin" on profiles for update using (is_admin());

-- animals
create policy "animals_select" on animals for select using (auth.uid() is not null);
create policy "animals_insert" on animals for insert with check (auth.uid() is not null);
create policy "animals_update_admin" on animals for update using (is_admin());

-- batch_counters (needs read+write from any logged-in user to generate codes)
create policy "counters_select" on batch_counters for select using (auth.uid() is not null);
create policy "counters_upsert" on batch_counters for insert with check (auth.uid() is not null);
create policy "counters_update" on batch_counters for update using (auth.uid() is not null);

-- slaughter
create policy "slaughter_sessions_select" on slaughter_sessions for select using (auth.uid() is not null);
create policy "slaughter_sessions_insert" on slaughter_sessions for insert with check (auth.uid() is not null);
create policy "slaughter_sessions_update_admin" on slaughter_sessions for update using (is_admin());
create policy "slaughter_items_select" on slaughter_items for select using (auth.uid() is not null);
create policy "slaughter_items_insert" on slaughter_items for insert with check (auth.uid() is not null);
create policy "slaughter_items_update_admin" on slaughter_items for update using (is_admin());

-- transport
create policy "transport_sessions_select" on transport_sessions for select using (auth.uid() is not null);
create policy "transport_sessions_insert" on transport_sessions for insert with check (auth.uid() is not null);
create policy "transport_sessions_update_admin" on transport_sessions for update using (is_admin());
create policy "transport_items_select" on transport_items for select using (auth.uid() is not null);
create policy "transport_items_insert" on transport_items for insert with check (auth.uid() is not null);
create policy "transport_items_update_admin" on transport_items for update using (is_admin());

-- receiving
create policy "receiving_select" on receiving_sessions for select using (auth.uid() is not null);
create policy "receiving_insert" on receiving_sessions for insert with check (auth.uid() is not null);
create policy "receiving_update_admin" on receiving_sessions for update using (is_admin());

-- packaging
create policy "packagings_select" on packagings for select using (auth.uid() is not null);
create policy "packagings_insert" on packagings for insert with check (auth.uid() is not null);
create policy "packagings_update_admin" on packagings for update using (is_admin());

-- sales
create policy "sales_select" on sales for select using (auth.uid() is not null);
create policy "sales_insert" on sales for insert with check (auth.uid() is not null);
create policy "sales_update_admin" on sales for update using (is_admin());

-- ============================================================
-- Seed reference data note (not a table -- soums are fixed in
-- app config, see app.js CONFIG.SOUMS)
-- ============================================================
