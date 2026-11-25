-- The math layer. Agents read these numbers; they never compute them.

-- Each stock sales week, flagged so it can be left out of baseline velocity.
create or replace view public.v_week_flags with (security_invoker = true) as
select ws.sku, ws.week_start, ws.units, ws.revenue,
  exists (select 1 from public.promos pr where pr.sku = ws.sku and ws.week_start between pr.start_date and pr.end_date) as is_promo_week,
  exists (select 1 from public.promos pr where pr.sku = ws.sku and ws.week_start = pr.end_date + 1) as is_post_promo_week,
  exists (select 1 from public.stockout_weeks so where so.sku = ws.sku and so.week_start = ws.week_start) as is_stockout_week
from public.weekly_sales ws
where ws.order_type = 'stock';

-- Per-SKU purchasing metrics.
--   baseline_velocity: avg weekly units, last 12 weeks (or since launch), excluding promo weeks,
--                      the week after each promo, stockout weeks and flow-through units
--   trend_pct:         last 4 weeks vs baseline, same exclusions
--   is_top_seller:     top 20% of established SKUs by 12-week revenue
--   wsoh_now:          (on hand + open POs) / baseline_velocity
--   projected_*:       stock left when a PO placed today lands (2-week planning lead time)
create or replace view public.v_sku_metrics with (security_invoker = true) as
with cfg as (
  select
    (select value::date from public.planning_config where key = 'as_of_date') as as_of,
    (select value::date from public.planning_config where key = 'last_complete_week') as last_week,
    (select value::int from public.planning_config where key = 'planning_lead_time_weeks') as lt
), win as (
  select f.*,
    f.week_start >= cfg.last_week - 77 as in_12,
    f.week_start >= cfg.last_week - 21 as in_4,
    not (f.is_promo_week or f.is_post_promo_week or f.is_stockout_week) as eligible
  from public.v_week_flags f cross join cfg
), agg as (
  select sku,
    count(*) filter (where in_12) as sales_weeks_12,
    count(*) filter (where in_12 and eligible) as eligible_weeks_12,
    sum(units) filter (where in_12 and eligible) as eligible_units_12,
    count(*) filter (where in_4 and eligible) as eligible_weeks_4,
    sum(units) filter (where in_4 and eligible) as eligible_units_4,
    count(*) filter (where in_12 and (is_promo_week or is_post_promo_week)) as promo_weeks_excluded,
    count(*) filter (where in_12 and is_stockout_week) as stockout_weeks_excluded,
    coalesce(sum(revenue) filter (where in_12), 0) as revenue_12
  from win group by sku
), ft as (
  select ws.sku, sum(ws.units) as flow_through_units_12
  from public.weekly_sales ws cross join cfg
  where ws.order_type = 'flow_through' and ws.week_start >= cfg.last_week - 77
  group by ws.sku
), po as (
  select pl.sku,
    sum(pl.qty) as open_po_units,
    sum(pl.qty) filter (where o.expected_delivery <= cfg.as_of + 7*cfg.lt) as open_po_units_by_arrival,
    min(o.expected_delivery) as next_delivery
  from public.po_lines pl
  join public.purchase_orders o on o.po_number = pl.po_number
  cross join cfg
  where o.status = 'open' and pl.order_type = 'stock'
  group by pl.sku
), up as (
  select pr.sku, min(pr.start_date) as next_promo_start
  from public.promos pr cross join cfg
  where pr.start_date > cfg.as_of
  group by pr.sku
), base as (
  select p.sku, p.name, b.id as brand_id, b.name as brand, l.id as lp_id, l.name as lp_name, l.lead_time_weeks,
    p.category, p.size, p.case_pack, p.wholesale_price, p.status, p.launch_date, p.is_limited_edition,
    coalesce(a.sales_weeks_12, 0) as sales_weeks_12,
    coalesce(a.eligible_weeks_12, 0) as eligible_weeks_12,
    round(a.eligible_units_12::numeric / nullif(a.eligible_weeks_12, 0), 2) as baseline_velocity,
    round(a.eligible_units_4::numeric / nullif(a.eligible_weeks_4, 0), 2) as velocity_4wk,
    coalesce(a.promo_weeks_excluded, 0) as promo_weeks_excluded,
    coalesce(a.stockout_weeks_excluded, 0) as stockout_weeks_excluded,
    coalesce(ft.flow_through_units_12, 0) as flow_through_units_12,
    coalesce(a.revenue_12, 0) as revenue_12,
    coalesce(i.on_hand_units, 0) as on_hand_units,
    coalesce(po.open_po_units, 0) as open_po_units,
    coalesce(po.open_po_units_by_arrival, 0) as open_po_units_by_arrival,
    po.next_delivery,
    up.next_promo_start,
    cfg.lt as planning_lead_time_weeks,
    case
      when p.launch_date > cfg.as_of then 'upcoming_launch'
      when p.status = 'delisted' then 'delisted'
      when coalesce(a.sales_weeks_12, 0) < 3 then 'new_launch'
      else 'established' end as lifecycle
  from public.products p
  join public.brands b on b.id = p.brand_id
  join public.lps l on l.id = b.lp_id
  cross join cfg
  left join agg a on a.sku = p.sku
  left join ft on ft.sku = p.sku
  left join po on po.sku = p.sku
  left join up on up.sku = p.sku
  left join public.inventory_on_hand i on i.sku = p.sku
)
select base.*,
  round((velocity_4wk / nullif(baseline_velocity, 0) - 1) * 100, 1) as trend_pct,
  case when lifecycle = 'established'
    then percent_rank() over (partition by (lifecycle = 'established') order by revenue_12) >= 0.8
    else false end as is_top_seller,
  round((on_hand_units + open_po_units) / nullif(baseline_velocity, 0), 2) as wsoh_now,
  round(on_hand_units + open_po_units_by_arrival - coalesce(baseline_velocity, 0) * planning_lead_time_weeks, 1) as projected_stock_at_arrival,
  round((on_hand_units + open_po_units_by_arrival - coalesce(baseline_velocity, 0) * planning_lead_time_weeks) / nullif(baseline_velocity, 0), 2) as projected_wsoh_at_arrival
from base;
