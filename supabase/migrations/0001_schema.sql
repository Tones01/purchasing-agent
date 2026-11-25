-- Core tables for a fictional cannabis wholesale distributor. RLS on everything.

create table public.lps (
  id serial primary key,
  name text not null unique,
  lead_time_weeks int not null check (lead_time_weeks in (1,2))
);

create table public.brands (
  id serial primary key,
  lp_id int not null references public.lps(id),
  name text not null unique
);

create table public.products (
  sku text primary key,
  name text not null,
  brand_id int not null references public.brands(id),
  category text not null check (category in ('flower','pre-roll','vape','edible','beverage','extract','topical')),
  size text not null,
  case_pack int not null check (case_pack > 0),
  unit_cost numeric(10,2) not null,
  wholesale_price numeric(10,2) not null,
  launch_date date not null,
  is_limited_edition boolean not null default false,
  status text not null check (status in ('active','delisted'))
);

create table public.stores (
  id serial primary key,
  name text not null,
  banner text,
  city text not null,
  province text not null check (province in ('SK','MB'))
);

create table public.weekly_sales (
  sku text not null references public.products(sku),
  week_start date not null,
  order_type text not null default 'stock' check (order_type in ('stock','flow_through')),
  units int not null check (units >= 0),
  revenue numeric(12,2) not null,
  primary key (sku, week_start, order_type)
);

create table public.stockout_weeks (
  sku text not null references public.products(sku),
  week_start date not null,
  primary key (sku, week_start)
);

create table public.promos (
  id serial primary key,
  sku text not null references public.products(sku),
  start_date date not null,
  end_date date not null,
  discount_pct numeric(5,2) not null,
  funded_by text not null check (funded_by in ('LP','OFD')),
  check (end_date >= start_date)
);

create table public.inventory_on_hand (
  sku text primary key references public.products(sku),
  on_hand_units int not null check (on_hand_units >= 0),
  as_of date not null
);

create table public.purchase_orders (
  po_number text primary key,
  lp_id int not null references public.lps(id),
  order_date date not null,
  expected_delivery date not null,
  status text not null check (status in ('open','received','cancelled'))
);

create table public.po_lines (
  po_number text not null references public.purchase_orders(po_number),
  sku text not null references public.products(sku),
  qty int not null check (qty > 0),
  order_type text not null default 'stock' check (order_type in ('stock','flow_through')),
  store_id int references public.stores(id),
  primary key (po_number, sku, order_type)
);

create table public.planning_config (
  key text primary key,
  value text not null,
  note text
);

create index on public.weekly_sales (week_start);
create index on public.po_lines (sku);
create index on public.promos (sku);
create index on public.brands (lp_id);
create index on public.products (brand_id);
create index on public.purchase_orders (lp_id);
create index on public.po_lines (store_id);
create index on public.stockout_weeks (week_start);

alter table public.lps enable row level security;
alter table public.brands enable row level security;
alter table public.products enable row level security;
alter table public.stores enable row level security;
alter table public.weekly_sales enable row level security;
alter table public.stockout_weeks enable row level security;
alter table public.promos enable row level security;
alter table public.inventory_on_hand enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.po_lines enable row level security;
alter table public.planning_config enable row level security;

-- Hidden answer key for evals. The MCP server's role cannot see this schema.
create schema if not exists eval_internal;
revoke all on schema eval_internal from public, anon, authenticated;

create table eval_internal.sku_params (
  sku text primary key references public.products(sku),
  base_velocity numeric not null,
  trend_slope numeric not null,
  target_wsoh numeric,
  past_promo_week int,
  past_promo_lift numeric,
  stockout_start_week int,
  stockout_len int
);
