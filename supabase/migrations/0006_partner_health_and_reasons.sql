-- Plan lines with a short, standard reason built by code (same wording every run),
-- and an LP / brand health check with fixed trouble thresholds.

create or replace view public.v_plan_export with (security_invoker = true) as
select p.*,
  pr.brand_id,
  ceil(coalesce(p.order_qty, 0)::numeric / p.case_pack)::int as cases,
  case when p.aging_bucket >= 4 then round(((p.on_hand_units + p.open_po_units) * p.unit_cost)::numeric, 2)::float8 else 0 end as aged_value,
  case
    when p.decision = 'reorder' then concat_ws(', ',
      case when p.lifecycle = 'upcoming_launch' then 'Upcoming launch'
           when p.lifecycle = 'new_launch' then 'New launch'
           when p.is_top_seller then 'Top seller'
           when p.trend_pct > 10 then 'Up ' || round(p.trend_pct::numeric) || '%'
           when p.trend_pct < -10 then 'Down ' || abs(round(p.trend_pct::numeric)) || '%'
           else 'Flat' end,
      case when p.velocity_source = 'similar_products'
           then round(p.plan_velocity::numeric) || '/wk from ' || p.similar_count || ' similar SKUs'
           else round(p.plan_velocity::numeric) || '/wk' end,
      coalesce(p.wsoh_now::numeric, 0) || ' wks now, ' || p.wsoh_after_order || ' after (target ' || p.target_weeks || ')',
      case when p.promo_start is not null
           then 'promo ' || to_char(p.promo_start::date, 'Mon DD') || ' +' || p.promo_extra_units || ' units at ' || p.promo_lift || 'x' end,
      case when p.rounding_note like 'rounded down%' then 'rounded down to ' || ceil(p.order_qty::numeric / p.case_pack) || ' cs'
           when p.rounding_note like 'case pack too large%' then 'case pack ' || p.case_pack || ' pushes past 8 wks'
           else ceil(coalesce(p.order_qty, 0)::numeric / p.case_pack) || ' cs of ' || p.case_pack end,
      case when p.urgent then 'URGENT: under 2 wks before a new PO lands' end)
    when p.decision = 'aging' then concat_ws(', ',
      case when coalesce(p.plan_velocity, 0) = 0 then 'No sales, ' || (p.on_hand_units + p.open_po_units) || ' units on hand'
           else p.wsoh_now || ' wks on hand' end,
      'bucket ' || p.aging_bucket || ': ' || p.aging_action || ' (' || p.aging_owner || ')')
    when p.decision = 'review' then 'No sales history and no similar brand + category SKUs to size the order'
    when p.decision = 'no_reorder' and p.is_limited_edition and coalesce(p.wsoh_now, 0) < 6
      then 'Limited edition, ' || coalesce(p.wsoh_now::numeric, 0) || ' wks left, cannot be reordered'
    else coalesce(p.wsoh_now::numeric, 0) || ' wks on hand, within 6 to 8'
  end as reason
from public.v_purchase_plan p
join public.products pr on pr.sku = p.sku;

create or replace view public.v_partner_health with (security_invoker = true) as
with x as materialized (
  select e.*, m.stockout_weeks_excluded
  from public.v_plan_export e
  join public.v_sku_metrics m on m.sku = e.sku
), g as (
  select 'lp'::text as level, lp_id, null::int as brand_id, max(lp_name) as name, max(lp_name) as lp_name,
    count(*) filter (where status = 'active')::int as active_skus,
    count(*) filter (where decision = 'reorder')::int as reorder_lines,
    coalesce(sum(order_qty) filter (where decision = 'reorder'), 0)::int as po_units,
    round(coalesce(sum(line_cost), 0)::numeric, 2)::float8 as po_cost,
    count(*) filter (where urgent)::int as urgent_lines,
    count(*) filter (where decision = 'aging' and status = 'active')::int as over_8_wks_skus,
    round(sum(aged_value)::numeric, 2)::float8 as aged_value_b4_b5,
    count(*) filter (where 'no_sales_with_stock' = any(review_flags))::int as dead_stock_skus,
    count(*) filter (where 'case_pack_overshoot' = any(review_flags))::int as case_pack_issues,
    count(*) filter (where stockout_weeks_excluded > 0)::int as stockout_skus,
    count(*) filter (where cardinality(review_flags) > 0)::int as review_lines
  from x group by lp_id
  union all
  select 'brand', lp_id, brand_id, max(brand), max(lp_name),
    count(*) filter (where status = 'active')::int,
    count(*) filter (where decision = 'reorder')::int,
    coalesce(sum(order_qty) filter (where decision = 'reorder'), 0)::int,
    round(coalesce(sum(line_cost), 0)::numeric, 2)::float8,
    count(*) filter (where urgent)::int,
    count(*) filter (where decision = 'aging' and status = 'active')::int,
    round(sum(aged_value)::numeric, 2)::float8,
    count(*) filter (where 'no_sales_with_stock' = any(review_flags))::int,
    count(*) filter (where 'case_pack_overshoot' = any(review_flags))::int,
    count(*) filter (where stockout_weeks_excluded > 0)::int,
    count(*) filter (where cardinality(review_flags) > 0)::int
  from x group by lp_id, brand_id
)
select h.*,
  rank() over (partition by h.level order by h.severity_score desc) as severity_rank,
  cardinality(h.trouble_reasons) > 0
    and rank() over (partition by h.level order by h.severity_score desc) <= case when h.level = 'lp' then 5 else 8 end as is_trouble
from (
  select g.*,
    -- Severity: urgent stock-outs and dead stock weigh most, then aged dollars and overstock share.
    round((urgent_lines * 3 + dead_stock_skus * 2 + case_pack_issues
      + aged_value_b4_b5 / 20000.0
      + case when active_skus > 0 then over_8_wks_skus::numeric / active_skus * 10 else 0 end)::numeric, 1)::float8 as severity_score,
    array_remove(array[
      case when urgent_lines >= case when level = 'lp' then 4 else 3 end
             or (active_skus >= 4 and urgent_lines::numeric / active_skus >= 0.3)
           then 'stock-out risk: ' || urgent_lines || ' urgent lines' end,
      case when active_skus >= 4 and over_8_wks_skus::numeric / active_skus >= 0.5
           then 'overstocked: ' || over_8_wks_skus || ' of ' || active_skus || ' active SKUs over 8 wks' end,
      case when aged_value_b4_b5 >= case when level = 'lp' then 75000 else 40000 end
           then 'aged stock: $' || to_char(aged_value_b4_b5, 'FM999,999') || ' in buckets 4-5' end,
      case when dead_stock_skus >= 3 then 'dead stock: ' || dead_stock_skus || ' SKUs with no sales' end,
      case when case_pack_issues >= 2 then 'case packs: ' || case_pack_issues || ' SKUs where the case pack forces overstock' end,
      case when stockout_skus >= 3 then 'stockouts: ' || stockout_skus || ' SKUs ran out in the last 12 wks' end
    ], null) as trouble_reasons
  from g
) h;

grant select on public.v_plan_export, public.v_partner_health to mcp_reader;
revoke all on public.v_plan_export, public.v_partner_health from anon, authenticated;
