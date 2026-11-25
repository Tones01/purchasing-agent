-- Purchase plan engine: applies the deterministic rules (spec v1.1) to every SKU.
-- Code decides trigger, target, promo forward buy, launch quantities, case pack rounding,
-- the urgent flag and aging buckets. Agents review the lines that carry review_flags.

create or replace view public.v_purchase_plan with (security_invoker = true) as
with cfg as (
  select
    (select value::date from public.planning_config where key = 'as_of_date') as as_of,
    (select value::int from public.planning_config where key = 'planning_lead_time_weeks') as lt
), m as materialized (
  select * from public.v_sku_metrics
), lift_sku as (
  select sku, avg(lift) as lift from public.v_promo_lift where lift is not null group by sku
), lift_brand as (
  select brand_id, avg(lift) as lift from public.v_promo_lift where lift is not null group by brand_id
), nextp as (
  -- next upcoming promo per SKU
  select distinct on (pr.sku) pr.sku, pr.start_date, pr.end_date,
    ((pr.end_date - pr.start_date) + 1) / 7.0 as promo_weeks
  from public.promos pr cross join cfg
  where pr.start_date > cfg.as_of
  order by pr.sku, pr.start_date
), sim as (
  -- similar products for launches: same brand + category, established, with sales
  select t.sku, avg(s.baseline_velocity) as v, count(s.sku)::int as n
  from m t
  join m s on s.brand_id = t.brand_id and s.category = t.category and s.sku <> t.sku
    and s.lifecycle = 'established' and s.baseline_velocity is not null
  where t.lifecycle in ('new_launch', 'upcoming_launch')
  group by t.sku
), p as (
  select m.*, pr.unit_cost, cfg.lt,
    case when m.lifecycle in ('new_launch', 'upcoming_launch') then sim.v else m.baseline_velocity end as pv,
    case when m.lifecycle in ('new_launch', 'upcoming_launch') then 'similar_products' else 'baseline' end as velocity_source,
    coalesce(sim.n, 0) as similar_count,
    m.on_hand_units + m.open_po_units as position,
    np.start_date as promo_start, np.end_date as promo_end, np.promo_weeks,
    case when np.sku is not null then coalesce(ls.lift, lb.lift, 1.5) end as promo_lift,
    case when np.sku is null then null
         when ls.lift is not null then 'sku_history'
         when lb.lift is not null then 'brand_average'
         else 'default_1.5x' end as lift_source
  from m
  cross join cfg
  join public.products pr on pr.sku = m.sku
  left join sim on sim.sku = m.sku
  left join nextp np on np.sku = m.sku
  left join lift_sku ls on ls.sku = m.sku
  left join lift_brand lb on lb.brand_id = m.brand_id
  where m.status = 'active' or m.on_hand_units + m.open_po_units > 0
), t as (
  select p.*,
    case when lifecycle in ('new_launch', 'upcoming_launch') then 6
         when is_top_seller then 8
         when trend_pct > 10 then 8
         when trend_pct < -10 then 6
         else 7 end as target_weeks,
    case when lifecycle in ('new_launch', 'upcoming_launch') then 'new launch: 6 weeks'
         when is_top_seller then 'top seller: 8 weeks'
         when trend_pct > 10 then 'trending up: 8 weeks'
         when trend_pct < -10 then 'slowing: 6 weeks'
         else 'flat: 7 weeks' end as target_reason,
    coalesce(round((promo_lift - 1) * pv * promo_weeks), 0) as promo_extra_units,
    round(position / nullif(pv, 0), 2) as wsoh_plan
  from p
), d as (
  select t.*,
    case
      when lifecycle = 'delisted' then 'aging'
      when coalesce(pv, 0) = 0 then case when lifecycle in ('new_launch', 'upcoming_launch') then 'review' else 'aging' end
      when lifecycle = 'upcoming_launch' then 'reorder'
      when wsoh_plan > 8 and promo_extra_units = 0 then 'aging'
      when is_limited_edition then 'no_reorder'
      when wsoh_plan < 6 or position < 6 * pv + promo_extra_units then 'reorder'
      else 'no_reorder' end as decision
  from t
), q as (
  select d.*,
    case when decision = 'reorder' then greatest(0, target_weeks * pv + promo_extra_units - position) end as raw_qty
  from d
), r as (
  select q.*,
    ceil(raw_qty / case_pack) * case_pack as qty_up,
    floor(raw_qty / case_pack) * case_pack as qty_down,
    8 * pv + promo_extra_units as cap_units,
    6 * pv + promo_extra_units as floor_units
  from q
), s as (
  select r.*,
    case
      when raw_qty is null then null
      when raw_qty = 0 then 0
      when position + qty_up <= cap_units then qty_up
      when qty_down > 0 and position + qty_down >= floor_units then qty_down
      else qty_up end as order_qty,
    case
      when raw_qty is null or raw_qty = 0 then null
      when position + qty_up <= cap_units then 'rounded up to case pack'
      when qty_down > 0 and position + qty_down >= floor_units then 'rounded down to stay at or under 8 weeks'
      else 'case pack too large: rounded up past 8 weeks' end as rounding_note,
    coalesce(pv, 0) > 0 and lifecycle <> 'upcoming_launch' and lifecycle <> 'delisted'
      and (on_hand_units + open_po_units_by_arrival - pv * lt) < 2 * pv as urgent
  from r
)
select
  sku, name, brand, lp_id, lp_name, category, size, lifecycle, status, is_limited_edition, is_top_seller,
  decision,
  round(pv::numeric, 2)::float8 as plan_velocity,
  velocity_source,
  similar_count,
  trend_pct::float8 as trend_pct,
  on_hand_units, open_po_units, position::int as position_units,
  wsoh_plan::float8 as wsoh_now,
  target_weeks, target_reason,
  promo_start::text as promo_start, promo_end::text as promo_end,
  round(promo_lift::numeric, 2)::float8 as promo_lift, lift_source, promo_extra_units::int as promo_extra_units,
  round(raw_qty::numeric, 1)::float8 as raw_qty,
  case_pack,
  order_qty::int as order_qty,
  rounding_note,
  round(((position + coalesce(order_qty, 0)) / nullif(pv, 0))::numeric, 2)::float8 as wsoh_after_order,
  unit_cost::float8 as unit_cost,
  round((coalesce(order_qty, 0) * unit_cost)::numeric, 2)::float8 as line_cost,
  urgent,
  case when decision = 'aging' then
    case when wsoh_plan is null or wsoh_plan > 26 then 5 when wsoh_plan > 17 then 4 when wsoh_plan > 13 then 3
         when wsoh_plan > 10 then 2 else 1 end end as aging_bucket,
  case when decision <> 'aging' then null
       when promo_start is not null then 'promo booked'
       when wsoh_plan is null or wsoh_plan > 26 then 'clearance or LP return conversation'
       when wsoh_plan > 17 then 'markdown'
       when wsoh_plan > 13 then 'ask LP for a supplier-funded promo'
       when wsoh_plan > 10 then 'feature in weekly catalogue and email'
       else 'watch, no reorder' end as aging_action,
  case when decision <> 'aging' then null
       when wsoh_plan is null or wsoh_plan > 26 then 'approver'
       when wsoh_plan > 17 then 'purchasing + approver'
       when wsoh_plan > 13 then 'sales'
       when wsoh_plan > 10 then 'marketing'
       else 'purchasing' end as aging_owner,
  array_remove(array[
    case when urgent then 'urgent' end,
    case when promo_start is not null and decision <> 'aging' then 'promo' end,
    case when lifecycle = 'new_launch' then 'new_launch' end,
    case when lifecycle = 'upcoming_launch' then 'upcoming_launch' end,
    case when lifecycle in ('new_launch', 'upcoming_launch') and similar_count = 0 then 'no_similar_products' end,
    case when rounding_note like 'case pack too large%' then 'case_pack_overshoot' end,
    case when is_limited_edition and coalesce(wsoh_plan, 0) < 6 then 'limited_edition_low' end,
    case when decision = 'aging' and coalesce(pv, 0) = 0 then 'no_sales_with_stock' end,
    case when decision = 'aging' and coalesce(wsoh_plan, 999) > 26 then 'bucket_5' end
  ], null) as review_flags,
  flow_through_units_12 > 0 as has_flow_through
from s;

grant select on public.v_purchase_plan to mcp_reader;
revoke all on public.v_purchase_plan from anon, authenticated;
