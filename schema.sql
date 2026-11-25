-- Asset Management: run this whole file in Supabase > SQL Editor > New query > Run.
-- Safe to run again on top of an older version: it never deletes your data.

-- ---------- Users and roles ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'pending' check (role in ('pending','procurement','projects','auditor')),
  created_at timestamptz default now()
);

-- Returns the logged-in user's role (runs with elevated rights so policies don't loop).
-- A user who is still 'pending' (not approved yet) gets NULL, so they can see and do nothing.
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select case when role = 'pending' then null else role end from public.profiles where id = auth.uid()
$$;

-- Every new sign-up starts as 'pending' with no access. Procurement approves them in the app (Users tab).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Properties and rooms ----------
create table if not exists properties (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  latitude double precision,
  longitude double precision,
  store_location text,
  created_at timestamptz default now()
);

create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  name text not null,              -- "101", "Lobby", "Gym" ...
  unique (property_id, name)
);

-- ---------- Assets ----------
create table if not exists assets (
  id uuid primary key default gen_random_uuid(),
  tag_no bigint generated always as identity,   -- shown on labels as AST-00001
  item_type text not null,                      -- Split AC, Chair, TV ...
  description text,                             -- make / model / serial
  property_id uuid references properties(id),   -- empty until the asset is assigned
  room_id uuid references rooms(id) on delete set null,
  in_store boolean not null default false,      -- true = kept in the property's store
  status text check (status in ('working','repairable','damaged')),   -- empty until assigned
  purchase_date date,
  purchase_cost numeric(12,2),
  vendor text,
  warranty_until date,
  photo_url text,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists assets_property_idx on assets(property_id);
create index if not exists assets_tag_idx on assets(tag_no);


-- ---------- History of transfers and status changes ----------
create table if not exists movements (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references assets(id) on delete cascade,
  kind text not null check (kind in ('transfer','status','assign','audit','deactivate','reactivate')),
  from_property uuid, from_room uuid, from_store boolean,
  to_property uuid, to_room uuid, to_store boolean,
  old_status text, new_status text,
  note text,
  lat double precision, lng double precision,
  done_by uuid default auth.uid(),
  done_by_name text,
  done_at timestamptz default now()
);
create index if not exists movements_asset_idx on movements(asset_id);

-- ---------- Unassigned assets (upgrade-safe) ----------
-- An asset can be bought first and placed later. While unassigned it has no property, room or status.
alter table assets alter column property_id drop not null;
alter table assets alter column status drop not null;
alter table assets alter column status drop default;
alter table movements drop constraint if exists movements_kind_check;
alter table movements add constraint movements_kind_check check (kind in ('transfer','status','assign','audit','deactivate','reactivate'));
-- Audit tracking: latest audit date on the asset; every audit is also kept as a history row (kind 'audit').
-- Asset name and size (optional, in addition to item type and description)
alter table assets add column if not exists name text;
alter table assets add column if not exists size text;
alter table properties add column if not exists audit_radius_m integer not null default 500;
alter table movements add column if not exists loc_verified boolean;
alter table assets add column if not exists last_audit_verified boolean;
alter table assets add column if not exists last_audited_at timestamptz;
alter table assets add column if not exists last_audited_by text;
create index if not exists assets_audited_idx on assets(last_audited_at);
alter table assets drop constraint if exists assets_assigned_needs_status;
alter table assets add constraint assets_assigned_needs_status check (property_id is null or status is not null);
alter table assets drop constraint if exists assets_unassigned_no_room;
alter table assets add constraint assets_unassigned_no_room check (property_id is not null or (room_id is null and in_store = false));
create index if not exists assets_unassigned_idx on assets(tag_no) where property_id is null;

-- ---------- v10: company, floors, room types, asset categories, deactivate (instead of delete) ----------
alter table properties add column if not exists active boolean not null default true;
alter table rooms      add column if not exists active boolean not null default true;
alter table assets     add column if not exists active boolean not null default true;
alter table assets     add column if not exists category text;

create table if not exists company (
  id integer primary key default 1 check (id = 1),
  name text not null default 'CLSPL',
  gst text,
  label_title text not null default 'CLSPL Asset',
  updated_at timestamptz default now()
);
insert into company (id) values (1) on conflict (id) do nothing;

create table if not exists floors (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  name text not null,
  sort integer not null default 0,
  active boolean not null default true,
  unique (property_id, name)
);
create index if not exists floors_property_idx on floors(property_id);

create table if not exists room_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort integer not null default 0,
  active boolean not null default true
);
insert into room_types (name, sort) values
  ('Studio', 10), ('Studio with washroom', 11),
  ('1 BHK', 20), ('1 BHK with washroom', 21),
  ('2 BHK', 30), ('2 BHK with washroom', 31),
  ('3 BHK', 40), ('3 BHK with washroom', 41),
  ('4 BHK', 50), ('4 BHK with washroom', 51),
  ('Common washroom', 90), ('Common area', 91)
  on conflict (name) do nothing;

alter table rooms add column if not exists floor_id uuid references floors(id) on delete set null;
alter table rooms add column if not exists room_type_id uuid references room_types(id) on delete set null;
create index if not exists rooms_floor_idx on rooms(floor_id);

create table if not exists asset_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort integer not null default 0,
  active boolean not null default true
);
create table if not exists asset_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references asset_categories(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  unique (category_id, name)
);
create unique index if not exists asset_items_name_uq on asset_items (lower(name));
-- existing assets: put their item types under a "General" category so nothing is lost
insert into asset_categories (name) values ('General') on conflict (name) do nothing;
insert into asset_items (category_id, name)
  select (select id from asset_categories where name = 'General'), t.item_type
    from (select distinct item_type from assets) t
  on conflict do nothing;
update assets set category = 'General' where category is null and active;   -- (deactivated assets cannot be edited, so they are skipped)

create index if not exists assets_active_idx on assets(active) where active = false;

-- a view that hides deactivated assets (used by the summary)
create or replace view public.active_assets with (security_invoker = true) as select * from public.assets where active;

-- ---------- Row level security ----------
alter table profiles   enable row level security;
alter table properties enable row level security;
alter table rooms      enable row level security;
alter table assets     enable row level security;
alter table movements  enable row level security;

drop policy if exists p_profiles_read on profiles;
create policy p_profiles_read on profiles for select to authenticated
  using (id = auth.uid() or (select public.my_role()) = 'procurement');
drop policy if exists p_profiles_update on profiles;
create policy p_profiles_update on profiles for update to authenticated
  using ((select public.my_role()) = 'procurement') with check ((select public.my_role()) = 'procurement');

drop policy if exists p_prop_read on properties;
create policy p_prop_read on properties for select to authenticated using ((select public.my_role()) is not null);
drop policy if exists p_prop_write on properties;
create policy p_prop_write on properties for all to authenticated
  using ((select public.my_role()) = 'procurement') with check ((select public.my_role()) = 'procurement');

drop policy if exists p_room_read on rooms;
create policy p_room_read on rooms for select to authenticated using ((select public.my_role()) is not null);
drop policy if exists p_room_write on rooms;
create policy p_room_write on rooms for all to authenticated
  using ((select public.my_role()) in ('procurement','projects')) with check ((select public.my_role()) in ('procurement','projects'));

alter table company          enable row level security;
alter table floors           enable row level security;
alter table room_types       enable row level security;
alter table asset_categories enable row level security;
alter table asset_items      enable row level security;
drop policy if exists p_company_read on company;
create policy p_company_read on company for select to authenticated using ((select public.my_role()) is not null);
drop policy if exists p_company_write on company;
create policy p_company_write on company for all to authenticated
  using ((select public.my_role()) = 'procurement') with check ((select public.my_role()) = 'procurement');
drop policy if exists p_floor_read on floors;
create policy p_floor_read on floors for select to authenticated using ((select public.my_role()) is not null);
drop policy if exists p_floor_write on floors;
create policy p_floor_write on floors for all to authenticated
  using ((select public.my_role()) in ('procurement','projects')) with check ((select public.my_role()) in ('procurement','projects'));
drop policy if exists p_rtype_read on room_types;
create policy p_rtype_read on room_types for select to authenticated using ((select public.my_role()) is not null);
drop policy if exists p_rtype_write on room_types;
create policy p_rtype_write on room_types for all to authenticated
  using ((select public.my_role()) in ('procurement','projects')) with check ((select public.my_role()) in ('procurement','projects'));
drop policy if exists p_cat_read on asset_categories;
create policy p_cat_read on asset_categories for select to authenticated using ((select public.my_role()) is not null);
drop policy if exists p_cat_write on asset_categories;
create policy p_cat_write on asset_categories for all to authenticated
  using ((select public.my_role()) in ('procurement','projects')) with check ((select public.my_role()) in ('procurement','projects'));
drop policy if exists p_item_read on asset_items;
create policy p_item_read on asset_items for select to authenticated using ((select public.my_role()) is not null);
drop policy if exists p_item_write on asset_items;
create policy p_item_write on asset_items for all to authenticated
  using ((select public.my_role()) in ('procurement','projects')) with check ((select public.my_role()) in ('procurement','projects'));

grant select, insert, update, delete on company, floors, room_types, asset_categories, asset_items to authenticated;
grant select on public.active_assets to authenticated;

-- deactivated assets cannot be changed (only reactivated); rooms, floors and properties cannot be deactivated while they still hold active things
create or replace function public.guard_assets_inactive() returns trigger language plpgsql as $$
begin
  if old.active = false and new.active = false then raise exception 'This asset is deactivated. Reactivate it first.'; end if;
  return new;
end $$;
drop trigger if exists assets_block_inactive on assets;
create trigger assets_block_inactive before update on assets for each row execute function public.guard_assets_inactive();

create or replace function public.guard_deactivate() returns trigger language plpgsql as $$
begin
  if old.active and not new.active then
    if tg_table_name = 'rooms' and exists (select 1 from assets where room_id = old.id and active) then
      raise exception 'This room still has active assets. Move or deactivate them first.';
    elsif tg_table_name = 'floors' and exists (select 1 from rooms where floor_id = old.id and active) then
      raise exception 'This floor still has active rooms. Deactivate the rooms first.';
    elsif tg_table_name = 'properties' and (exists (select 1 from rooms where property_id = old.id and active) or exists (select 1 from assets where property_id = old.id and active)) then
      raise exception 'This property still has active rooms or assets. Deactivate them first.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists rooms_guard_deactivate on rooms;
create trigger rooms_guard_deactivate before update on rooms for each row execute function public.guard_deactivate();
drop trigger if exists floors_guard_deactivate on floors;
create trigger floors_guard_deactivate before update on floors for each row execute function public.guard_deactivate();
drop trigger if exists properties_guard_deactivate on properties;
create trigger properties_guard_deactivate before update on properties for each row execute function public.guard_deactivate();

drop policy if exists p_asset_read on assets;
create policy p_asset_read on assets for select to authenticated using ((select public.my_role()) is not null);
drop policy if exists p_asset_insert on assets;
create policy p_asset_insert on assets for insert to authenticated
  with check ((select public.my_role()) in ('procurement','projects'));
drop policy if exists p_asset_update on assets;
create policy p_asset_update on assets for update to authenticated
  using ((select public.my_role()) in ('procurement','projects'))
  with check ((select public.my_role()) in ('procurement','projects'));
drop policy if exists p_asset_delete on assets;
create policy p_asset_delete on assets for delete to authenticated
  using ((select public.my_role()) = 'procurement');

drop policy if exists p_move_read on movements;
create policy p_move_read on movements for select to authenticated using ((select public.my_role()) is not null);
-- No insert policy on purpose: movements are only written by the two functions below.

-- ---------- Transfer and status change (usable by all three roles, incl. auditors) ----------
create or replace function public.transfer_asset(
  p_asset uuid, p_property uuid, p_room uuid, p_to_store boolean,
  p_note text, p_lat double precision, p_lng double precision
) returns void
language plpgsql security definer set search_path = public as $$
declare a assets%rowtype; who text;
begin
  if public.my_role() is null then raise exception 'Not allowed'; end if;
  select * into a from assets where id = p_asset;
  if not found then raise exception 'Asset not found'; end if;
  if a.property_id is null then raise exception 'Assign this asset to a property and room first'; end if;
  if not p_to_store and p_room is null then raise exception 'Pick a room or the store'; end if;
  select coalesce(nullif(full_name,''), email) into who from profiles where id = auth.uid();
  insert into movements (asset_id, kind, from_property, from_room, from_store,
                         to_property, to_room, to_store, note, lat, lng, done_by_name)
  values (p_asset, 'transfer', a.property_id, a.room_id, a.in_store,
          p_property, case when p_to_store then null else p_room end, p_to_store,
          p_note, p_lat, p_lng, who);
  update assets set property_id = p_property,
                    room_id = case when p_to_store then null else p_room end,
                    in_store = p_to_store, updated_at = now()
   where id = p_asset;
end $$;

create or replace function public.change_asset_status(
  p_asset uuid, p_status text, p_note text, p_lat double precision, p_lng double precision
) returns void
language plpgsql security definer set search_path = public as $$
declare a assets%rowtype; who text;
begin
  if public.my_role() is null then raise exception 'Not allowed'; end if;
  if p_status not in ('working','repairable','damaged') then raise exception 'Bad status'; end if;
  select * into a from assets where id = p_asset;
  if not found then raise exception 'Asset not found'; end if;
  if a.property_id is null then raise exception 'Assign this asset to a property and room first'; end if;
  select coalesce(nullif(full_name,''), email) into who from profiles where id = auth.uid();
  insert into movements (asset_id, kind, old_status, new_status, note, lat, lng, done_by_name)
  values (p_asset, 'status', a.status, p_status, p_note, p_lat, p_lng, who);
  update assets set status = p_status, updated_at = now() where id = p_asset;
end $$;

-- Assign a purchased (unassigned) asset: Procurement or Projects team only. Property, room/store and status are all required.
create or replace function public.assign_asset(
  p_asset uuid, p_property uuid, p_room uuid, p_to_store boolean, p_status text, p_note text
) returns void
language plpgsql security definer set search_path = public as $$
declare a assets%rowtype; who text;
begin
  if coalesce(public.my_role(), '') not in ('procurement','projects') then raise exception 'Not allowed'; end if;
  select * into a from assets where id = p_asset for update;
  if not found then raise exception 'Asset not found'; end if;
  if a.property_id is not null then raise exception 'This asset is already assigned. Use Transfer to move it.'; end if;
  if p_property is null then raise exception 'Choose a property'; end if;
  if not coalesce(p_to_store, false) and p_room is null then raise exception 'Choose a room or the store'; end if;
  if p_status is null or p_status not in ('working','repairable','damaged') then raise exception 'Choose a status'; end if;
  if not coalesce(p_to_store, false) and not exists (select 1 from rooms where id = p_room and property_id = p_property) then
    raise exception 'That room does not belong to the property';
  end if;
  select coalesce(nullif(full_name,''), email) into who from profiles where id = auth.uid();
  insert into movements (asset_id, kind, to_property, to_room, to_store, new_status, note, done_by_name)
  values (p_asset, 'assign', p_property, case when coalesce(p_to_store,false) then null else p_room end, coalesce(p_to_store,false), p_status, p_note, who);
  update assets set property_id = p_property,
                    room_id = case when coalesce(p_to_store,false) then null else p_room end,
                    in_store = coalesce(p_to_store,false), status = p_status, updated_at = now()
   where id = p_asset;
end $$;

-- ---------- Bulk assign (Procurement / Projects team) ----------
-- Assign many unassigned assets to ONE place. Either pass a list of ids (ticked rows), or a filter plus a quantity.
-- Returns the ids that were assigned. All three of property, room/store and status are required.
create or replace function public.assign_bulk(
  p_ids uuid[], p_item_type text, p_search text, p_qty integer,
  p_property uuid, p_room uuid, p_to_store boolean, p_status text, p_note text
) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare v_ids uuid[]; who text; v_store boolean := coalesce(p_to_store, false);
begin
  if coalesce(public.my_role(), '') not in ('procurement','projects') then raise exception 'Not allowed'; end if;
  if p_property is null then raise exception 'Choose a property'; end if;
  if not v_store and p_room is null then raise exception 'Choose a room or the store'; end if;
  if p_status is null or p_status not in ('working','repairable','damaged') then raise exception 'Choose a status'; end if;
  if not v_store and not exists (select 1 from rooms where id = p_room and property_id = p_property) then
    raise exception 'That room does not belong to the property';
  end if;
  select array_agg(s.id order by s.tag_no) into v_ids from (
    select id, tag_no from assets
     where property_id is null and active
       and (p_ids is null or id = any(p_ids))
       and (p_item_type is null or item_type = p_item_type)
       and (nullif(p_search, '') is null or item_type ilike '%' || p_search || '%'
            or description ilike '%' || p_search || '%' or name ilike '%' || p_search || '%' or vendor ilike '%' || p_search || '%')
     order by tag_no
     limit coalesce(p_qty, 2147483647)
     for update skip locked) s;
  if v_ids is null then return '{}'::uuid[]; end if;
  select coalesce(nullif(full_name,''), email) into who from profiles where id = auth.uid();
  update assets set property_id = p_property, room_id = case when v_store then null else p_room end,
                    in_store = v_store, status = p_status, updated_at = now()
   where id = any(v_ids);
  insert into movements (asset_id, kind, to_property, to_room, to_store, new_status, note, done_by_name)
  select unnest(v_ids), 'assign', p_property, case when v_store then null else p_room end, v_store, p_status, p_note, who;
  return v_ids;
end $$;

-- Spread unassigned assets evenly: p_per_room items into EACH chosen room (and the store, if included).
-- Rooms you leave out of p_rooms get nothing. Nothing happens unless there are enough assets for every place.
create or replace function public.assign_spread(
  p_item_type text, p_search text, p_per_room integer,
  p_property uuid, p_rooms uuid[], p_include_store boolean, p_status text, p_note text
) returns uuid[]
language plpgsql security definer set search_path = public as $$
declare v_ids uuid[]; who text; v_rooms uuid[] := coalesce(p_rooms, '{}'::uuid[]);
        v_store boolean := coalesce(p_include_store, false); v_places integer; v_need integer; v_got integer;
begin
  if coalesce(public.my_role(), '') not in ('procurement','projects') then raise exception 'Not allowed'; end if;
  if p_property is null then raise exception 'Choose a property'; end if;
  if p_status is null or p_status not in ('working','repairable','damaged') then raise exception 'Choose a status'; end if;
  if p_item_type is null then raise exception 'Choose the item type to spread (for example Chair)'; end if;
  if p_per_room is null or p_per_room < 1 then raise exception 'Items per room must be 1 or more'; end if;
  v_places := cardinality(v_rooms) + case when v_store then 1 else 0 end;
  if v_places = 0 then raise exception 'Choose at least one room'; end if;
  if (select count(*) from rooms where property_id = p_property and id = any(v_rooms)) <> cardinality(v_rooms) then
    raise exception 'Some of the chosen rooms do not belong to the property';
  end if;
  v_need := p_per_room * v_places;
  select array_agg(s.id order by s.tag_no) into v_ids from (
    select id, tag_no from assets
     where property_id is null and active and item_type = p_item_type
       and (nullif(p_search, '') is null or item_type ilike '%' || p_search || '%'
            or description ilike '%' || p_search || '%' or name ilike '%' || p_search || '%' or vendor ilike '%' || p_search || '%')
     order by tag_no
     limit v_need
     for update skip locked) s;
  v_got := coalesce(cardinality(v_ids), 0);
  if v_got < v_need then
    raise exception 'Only % unassigned asset(s) are available, but % are needed (% per place x % places)', v_got, v_need, p_per_room, v_places;
  end if;
  select coalesce(nullif(full_name,''), email) into who from profiles where id = auth.uid();
  update assets a set property_id = p_property,
         room_id  = case when ((t.rn - 1) / p_per_room) + 1 <= cardinality(v_rooms) then v_rooms[(((t.rn - 1) / p_per_room) + 1)::int] else null end,
         in_store = (((t.rn - 1) / p_per_room) + 1 > cardinality(v_rooms)),
         status = p_status, updated_at = now()
    from unnest(v_ids) with ordinality as t(id, rn)
   where a.id = t.id;
  insert into movements (asset_id, kind, to_property, to_room, to_store, new_status, note, done_by_name)
  select a.id, 'assign', p_property, a.room_id, a.in_store, p_status, p_note, who from assets a where a.id = any(v_ids);
  return v_ids;
end $$;

revoke execute on function public.assign_bulk(uuid[],text,text,integer,uuid,uuid,boolean,text,text) from public, anon;
grant execute on function public.assign_bulk(uuid[],text,text,integer,uuid,uuid,boolean,text,text) to authenticated;
revoke execute on function public.assign_spread(text,text,integer,uuid,uuid[],boolean,text,text) from public, anon;
grant execute on function public.assign_spread(text,text,integer,uuid,uuid[],boolean,text,text) to authenticated;

revoke execute on function public.transfer_asset(uuid,uuid,uuid,boolean,text,double precision,double precision) from public, anon;
revoke execute on function public.change_asset_status(uuid,text,text,double precision,double precision) from public, anon;
grant execute on function public.transfer_asset(uuid,uuid,uuid,boolean,text,double precision,double precision) to authenticated;
grant execute on function public.change_asset_status(uuid,text,text,double precision,double precision) to authenticated;
revoke execute on function public.assign_asset(uuid,uuid,uuid,boolean,text,text) from public, anon;
grant execute on function public.assign_asset(uuid,uuid,uuid,boolean,text,text) to authenticated;

-- ---------- Audit (Auditor / Projects / Procurement) ----------
-- Distance in metres between two lat/lng points.
create or replace function public.distance_m(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- Records "audited OK". The auditor must be at the property the asset is recorded in (within that property's radius):
--  * at a different property  -> refused, the asset must be transferred first
--  * away from every property -> refused
--  * no location sent, or the recorded property has no map pin -> allowed, entry marked "location not verified"
create or replace function public.audit_asset(
  p_asset uuid, p_note text, p_lat double precision, p_lng double precision
) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare a assets%rowtype; rp properties%rowtype; op properties%rowtype; who text; ts timestamptz := now();
        d double precision; verified boolean := false;
begin
  if coalesce(public.my_role(), '') not in ('procurement','projects','auditor') then raise exception 'Not allowed'; end if;
  select * into a from assets where id = p_asset;
  if not found then raise exception 'Asset not found'; end if;
  if a.property_id is null then raise exception 'Assign this asset to a property and room before auditing it'; end if;
  select * into rp from properties where id = a.property_id;
  if p_lat is not null and p_lng is not null then
    if rp.latitude is not null and rp.longitude is not null then
      d := public.distance_m(p_lat, p_lng, rp.latitude, rp.longitude);
      if d <= rp.audit_radius_m then
        verified := true;
      else
        select * into op from properties
         where id <> rp.id and latitude is not null and longitude is not null
           and public.distance_m(p_lat, p_lng, latitude, longitude) <= audit_radius_m
         order by public.distance_m(p_lat, p_lng, latitude, longitude) limit 1;
        if found then
          raise exception 'This asset is recorded at %, but you are at %. Transfer it to % before auditing.', rp.name, op.name, op.name;
        end if;
        raise exception 'You are % m from %, but the allowed distance is % m. Go to the property to audit this asset.', round(d), rp.name, rp.audit_radius_m;
      end if;
    else
      -- recorded property has no pin: only refuse if the auditor is clearly at another pinned property
      select * into op from properties
       where id <> rp.id and latitude is not null and longitude is not null
         and public.distance_m(p_lat, p_lng, latitude, longitude) <= audit_radius_m
       order by public.distance_m(p_lat, p_lng, latitude, longitude) limit 1;
      if found then
        raise exception 'This asset is recorded at %, but you are at %. Transfer it to % before auditing.', rp.name, op.name, op.name;
      end if;
    end if;
  end if;
  select coalesce(nullif(full_name,''), email) into who from profiles where id = auth.uid();
  insert into movements (asset_id, kind, to_property, to_room, to_store, new_status, note, lat, lng, done_by_name, done_at, loc_verified)
  values (p_asset, 'audit', a.property_id, a.room_id, a.in_store, a.status, p_note, p_lat, p_lng, who, ts, verified);
  update assets set last_audited_at = ts, last_audited_by = who, last_audit_verified = verified where id = p_asset;
  return ts;
end $$;

-- ---------- Deactivate / reactivate (Procurement only; assets are never deleted) ----------
-- Matches a list of ids and/or the same filters the Assets list uses. Needs at least one condition.
-- Changes at most p_limit per call; the app repeats the call until done. Returns how many were changed.
drop function if exists public.delete_assets(uuid[],uuid,boolean,text,text,text,integer,text,date,integer);
create or replace function public.set_assets_active(
  p_ids uuid[], p_property uuid, p_unassigned boolean, p_item_type text, p_status text,
  p_search text, p_tag integer, p_audit text, p_before date, p_limit integer, p_active boolean
) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; who text;
begin
  if coalesce(public.my_role(), '') <> 'procurement' then raise exception 'Only Procurement can deactivate or reactivate assets'; end if;
  if p_ids is null and p_property is null and not coalesce(p_unassigned, false) and p_item_type is null
     and p_status is null and nullif(p_search, '') is null and p_tag is null and p_audit is null then
    raise exception 'Choose at least one filter or tick some assets first';
  end if;
  select coalesce(nullif(full_name,''), email) into who from profiles where id = auth.uid();
  with picked as (
    select id from assets
     where active <> p_active
       and (p_ids is null or id = any(p_ids))
       and (p_property is null or property_id = p_property)
       and (not coalesce(p_unassigned, false) or property_id is null)
       and (p_item_type is null or item_type = p_item_type)
       and (p_status is null or status = p_status)
       and (p_tag is null or tag_no = p_tag)
       and (nullif(p_search, '') is null or item_type ilike '%' || p_search || '%'
            or description ilike '%' || p_search || '%' or name ilike '%' || p_search || '%' or vendor ilike '%' || p_search || '%')
       and (p_audit is null
            or (p_audit = 'yes' and last_audited_at is not null)
            or (p_audit = 'no' and last_audited_at is null)
            or (p_audit = 'before' and (last_audited_at is null or last_audited_at < p_before::timestamptz)))
     order by tag_no
     limit greatest(coalesce(p_limit, 2000), 1)
     for update skip locked),
  upd as (
    update assets a set active = p_active, updated_at = now() from picked where a.id = picked.id returning a.id)
  insert into movements (asset_id, kind, done_by_name)
  select id, case when p_active then 'reactivate' else 'deactivate' end, who from upd;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.set_assets_active(uuid[],uuid,boolean,text,text,text,integer,text,date,integer,boolean) from public, anon;
grant execute on function public.set_assets_active(uuid[],uuid,boolean,text,text,text,integer,text,date,integer,boolean) to authenticated;

revoke execute on function public.audit_asset(uuid,text,double precision,double precision) from public, anon;
grant execute on function public.audit_asset(uuid,text,double precision,double precision) to authenticated;

-- ---------- To audit: what is still not audited, room by room ----------
-- For one property: every room (and the store) with its asset count and how many are not audited.
-- "Not audited" = never audited, or last audited before p_before (when given).
create or replace function public.audit_pending(p_property uuid, p_before date)
returns table (room_id uuid, room_name text, in_store boolean, total bigint, pending bigint)
language sql stable set search_path = public as $$
  select r.id, r.name, false,
         count(a.id),
         count(a.id) filter (where a.last_audited_at is null or (p_before is not null and a.last_audited_at < p_before::timestamptz))
    from rooms r left join assets a on a.room_id = r.id and a.property_id = p_property and not a.in_store and a.active
   where r.property_id = p_property and r.active
   group by r.id, r.name
  union all
  select null::uuid, 'Store', true,
         count(a.id),
         count(a.id) filter (where a.last_audited_at is null or (p_before is not null and a.last_audited_at < p_before::timestamptz))
    from assets a where a.property_id = p_property and a.in_store and a.active
$$;
revoke execute on function public.audit_pending(uuid,date) from public, anon;
grant execute on function public.audit_pending(uuid,date) to authenticated;

-- ---------- Audit report: audited vs not audited, room by room, for every property ----------
-- "Audited" = audited at least once (p_before null) or audited on/after p_before. Assets not placed yet are left out.
create or replace function public.audit_report(p_before date)
returns table (property_id uuid, property_name text, room_id uuid, room_name text, in_store boolean,
               total bigint, audited bigint, last_audit timestamptz)
language sql stable set search_path = public as $$
  select p.id, p.name, r.id, r.name, false,
         count(a.id),
         count(a.id) filter (where a.last_audited_at is not null and (p_before is null or a.last_audited_at >= p_before::timestamptz)),
         max(a.last_audited_at)
    from properties p join rooms r on r.property_id = p.id and r.active
    left join assets a on a.active and a.room_id = r.id and a.property_id = p.id and not a.in_store
   where p.active
   group by p.id, p.name, r.id, r.name
  union all
  select p.id, p.name, null::uuid, 'Store', true,
         count(a.id),
         count(a.id) filter (where a.last_audited_at is not null and (p_before is null or a.last_audited_at >= p_before::timestamptz)),
         max(a.last_audited_at)
    from properties p left join assets a on a.active and a.property_id = p.id and a.in_store
   where p.active
   group by p.id, p.name
  union all
  select p.id, p.name, null::uuid, '(no room)', false,
         count(a.id),
         count(a.id) filter (where a.last_audited_at is not null and (p_before is null or a.last_audited_at >= p_before::timestamptz)),
         max(a.last_audited_at)
    from properties p left join assets a on a.active and a.property_id = p.id and a.room_id is null and not a.in_store
   where p.active
   group by p.id, p.name
$$;
revoke execute on function public.audit_report(date) from public, anon;
grant execute on function public.audit_report(date) to authenticated;

-- ---------- Speed for ~100,000 assets ----------
create index if not exists assets_prop_room_idx on assets(property_id, room_id);
create index if not exists assets_type_idx on assets(item_type);
create index if not exists assets_status_idx on assets(status);

-- Distinct item types (for dropdowns).
create or replace function public.item_types() returns setof text
language sql stable as $$ select distinct item_type from public.assets where active order by 1 $$;

-- All summary numbers calculated inside the database (property-wise, item-wise, matrix).
create or replace function public.asset_summary() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'total',      (select count(*) from public.active_assets),
    'working',    (select count(*) from public.active_assets where status = 'working'),
    'repairable', (select count(*) from public.active_assets where status = 'repairable'),
    'damaged',    (select count(*) from public.active_assets where status = 'damaged'),
    'cost',       (select coalesce(sum(purchase_cost), 0) from public.active_assets),
    'warranty_90',(select count(*) from public.active_assets where warranty_until between current_date and current_date + 90),
    'audited',    (select count(*) from public.active_assets where last_audited_at is not null),
    'unassigned', (select jsonb_build_object('total', count(*), 'cost', coalesce(sum(purchase_cost), 0)) from public.active_assets where property_id is null),
    'by_property',(select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) from (
        select p.id, p.name, count(a.id) as total,
               count(a.id) filter (where a.status = 'working') as working,
               count(a.id) filter (where a.status = 'repairable') as repairable,
               count(a.id) filter (where a.status = 'damaged') as damaged,
               count(a.id) filter (where a.last_audited_at is not null) as audited,
               coalesce(sum(a.purchase_cost), 0) as cost
          from public.properties p left join public.active_assets a on a.property_id = p.id
         where p.active group by p.id, p.name) x),
    'by_item',    (select coalesce(jsonb_agg(x order by x.item_type), '[]'::jsonb) from (
        select item_type, count(*) as total,
               count(*) filter (where status = 'working') as working,
               count(*) filter (where status = 'repairable') as repairable,
               count(*) filter (where status = 'damaged') as damaged,
               coalesce(sum(purchase_cost), 0) as cost
          from public.active_assets group by item_type) x),
    'matrix',     (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select property_id, item_type, count(*) as n from public.active_assets group by 1, 2) x)
  )
$$;

revoke execute on function public.item_types() from public, anon;
revoke execute on function public.asset_summary() from public, anon;
grant execute on function public.item_types() to authenticated;
grant execute on function public.asset_summary() to authenticated;

-- ---------- Photo storage ----------
insert into storage.buckets (id, name, public) values ('asset-photos', 'asset-photos', true)
  on conflict (id) do nothing;

drop policy if exists photos_read on storage.objects;
create policy photos_read on storage.objects for select using (bucket_id = 'asset-photos');
drop policy if exists photos_insert on storage.objects;
create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'asset-photos' and (select public.my_role()) in ('procurement','projects'));

-- ---------- After you sign up in the app, make yourself Procurement (replace the email): ----------
-- update profiles set role = 'procurement' where email = 'you@example.com';
