import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { db } from "./db";

type Server = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

// Every tool is read-only. The database role behind them can only SELECT.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const DEFAULT_PROMO_LIFT = 1.5;

// Columns returned for a SKU's purchasing metrics (all calculated in the database view v_sku_metrics).
const METRIC_COLS = `
  sku, name, brand, lp_id, lp_name, category, size, case_pack, wholesale_price::float8 as wholesale_price,
  status, launch_date::text as launch_date, is_limited_edition, lifecycle,
  sales_weeks_12::int as sales_weeks_12, eligible_weeks_12::int as eligible_weeks_12,
  baseline_velocity::float8 as baseline_velocity, velocity_4wk::float8 as velocity_4wk, trend_pct::float8 as trend_pct,
  is_top_seller, revenue_12::float8 as revenue_12,
  promo_weeks_excluded::int as promo_weeks_excluded, stockout_weeks_excluded::int as stockout_weeks_excluded,
  flow_through_units_12::int as flow_through_units_12,
  on_hand_units::int as on_hand_units, open_po_units::int as open_po_units,
  open_po_units_by_arrival::int as open_po_units_by_arrival, next_delivery::text as next_delivery,
  next_promo_start::text as next_promo_start,
  wsoh_now::float8 as wsoh_now, projected_stock_at_arrival::float8 as projected_stock_at_arrival,
  projected_wsoh_at_arrival::float8 as projected_wsoh_at_arrival`;

const METRIC_DEFINITIONS = {
  baseline_velocity:
    "Average weekly stock units over the last 12 weeks (or since launch), excluding promo weeks, the week after each promo, stockout weeks and all flow-through units. Null if no eligible weeks.",
  velocity_4wk: "Same exclusions, last 4 weeks only.",
  trend_pct: "(velocity_4wk / baseline_velocity - 1) x 100.",
  is_top_seller: "Established SKU in the top 20% by 12-week revenue.",
  lifecycle:
    "upcoming_launch (launch date after the planning date), new_launch (under 3 weeks of sales), established, or delisted.",
  wsoh_now: "(on_hand_units + open_po_units) / baseline_velocity.",
  projected_stock_at_arrival:
    "on_hand_units + open_po_units_by_arrival - baseline_velocity x planning lead time (2 weeks). Stock left when a PO placed today lands.",
  projected_wsoh_at_arrival: "projected_stock_at_arrival / baseline_velocity.",
};

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (err) {
    console.error(err);
    return fail(err instanceof Error ? err.message : "Unexpected error");
  }
}

const sku = z.string().regex(/^SKU-\d{5}$/, "SKU format is SKU-00000").describe("Product SKU, e.g. SKU-00123");
const lpId = z.number().int().positive().describe("LP id from list_lps");

export function registerTools(server: Server) {
  const sql = db();
  const cols = sql.unsafe(METRIC_COLS);

  server.registerTool(
    "get_planning_context",
    {
      title: "Planning context",
      description:
        "Start here. Returns the planning run date, sales history window, planning lead time, and how every calculated metric is defined.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const config = await sql`select key, value, note from planning_config order by key`;
        return { config, metric_definitions: METRIC_DEFINITIONS };
      }),
  );

  server.registerTool(
    "list_lps",
    {
      title: "List LPs",
      description:
        "Lists every LP (licensed producer / supplier) with its lead time, brands, active SKU count and open PO count. Use the id to pull an LP's stock overview.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      run(
        () => sql`
          select l.id, l.name, l.lead_time_weeks,
            (select array_agg(b2.name order by b2.name) from brands b2 where b2.lp_id = l.id) as brands,
            count(distinct p.sku) filter (where p.status = 'active')::int as active_skus,
            (select count(*)::int from purchase_orders o where o.lp_id = l.id and o.status = 'open') as open_pos
          from lps l
          left join brands b on b.lp_id = l.id
          left join products p on p.brand_id = b.id
          group by l.id
          order by l.id`,
      ),
  );

  server.registerTool(
    "get_lp_stock_overview",
    {
      title: "LP stock overview",
      description:
        "Purchasing metrics for every SKU from one LP: sales speed, trend, top seller flag, lifecycle, on hand, open POs, weeks of stock now and projected at arrival, upcoming promo date, case pack. This is the main screening tool for reorders. Delisted SKUs are left out unless include_delisted is true.",
      inputSchema: z.object({
        lp_id: lpId,
        include_delisted: z.boolean().default(false).describe("Include delisted SKUs (default false)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ lp_id, include_delisted }) =>
      run(async () => {
        const rows = await sql`
          select ${cols} from v_sku_metrics
          where lp_id = ${lp_id} and (${include_delisted} or status = 'active')
          order by brand, category, sku`;
        return { lp_id, sku_count: rows.length, skus: rows };
      }),
  );

  server.registerTool(
    "get_sku_detail",
    {
      title: "SKU detail",
      description:
        "Everything about one SKU: its metrics, 26 weeks of stock sales with promo / post-promo / stockout flags, flow-through weeks, all promos, and open PO lines. Use it to check or explain a recommendation.",
      inputSchema: z.object({ sku }),
      annotations: READ_ONLY,
    },
    async ({ sku }) =>
      run(async () => {
        const [metrics] = await sql`select ${cols} from v_sku_metrics where sku = ${sku}`;
        if (!metrics) throw new Error(`Unknown SKU ${sku}`);
        const [history, flowThrough, promos, openPoLines] = await Promise.all([
          sql`select week_start::text as week_start, units, revenue::float8 as revenue, is_promo_week, is_post_promo_week, is_stockout_week
              from v_week_flags where sku = ${sku} order by week_start`,
          sql`select week_start::text as week_start, units from weekly_sales
              where sku = ${sku} and order_type = 'flow_through' order by week_start`,
          sql`select start_date::text as start_date, end_date::text as end_date, discount_pct::float8 as discount_pct, funded_by
              from promos where sku = ${sku} order by start_date`,
          sql`select pl.po_number, pl.qty, pl.order_type, pl.store_id, o.expected_delivery::text as expected_delivery
              from po_lines pl join purchase_orders o on o.po_number = pl.po_number
              where pl.sku = ${sku} and o.status = 'open' order by o.expected_delivery`,
        ]);
        return { metrics, weekly_stock_sales: history, flow_through_weeks: flowThrough, promos, open_po_lines: openPoLines };
      }),
  );

  server.registerTool(
    "find_similar_products",
    {
      title: "Similar products",
      description:
        "For a new or upcoming launch: established SKUs from the same brand and category, with their sales speed and the average. If none exist, the result says so and the launch should be flagged for the approver.",
      inputSchema: z.object({ sku }),
      annotations: READ_ONLY,
    },
    async ({ sku }) =>
      run(async () => {
        const [target] = await sql`select sku, brand, brand_id, category, size, lifecycle from v_sku_metrics where sku = ${sku}`;
        if (!target) throw new Error(`Unknown SKU ${sku}`);
        const similar = await sql`
          select sku, name, size, baseline_velocity::float8 as baseline_velocity, eligible_weeks_12::int as eligible_weeks_12
          from v_sku_metrics
          where brand_id = ${target.brand_id} and category = ${target.category} and sku <> ${sku}
            and lifecycle = 'established' and baseline_velocity is not null
          order by baseline_velocity desc`;
        const avg = similar.length
          ? Math.round((similar.reduce((s, r) => s + Number(r.baseline_velocity), 0) / similar.length) * 100) / 100
          : null;
        return {
          target: { sku: target.sku, brand: target.brand, category: target.category, size: target.size, lifecycle: target.lifecycle },
          similar_count: similar.length,
          average_baseline_velocity: avg,
          similar_products: similar,
          note: similar.length ? undefined : "No similar products (same brand and category). Flag for the approver.",
        };
      }),
  );

  server.registerTool(
    "get_promo_lift",
    {
      title: "Promo lift",
      description:
        "Past promo lift for one SKU and its brand, plus the SKU's upcoming promos. Lift = average units in promo weeks / average of the 4 normal weeks before the promo (after, if there is no history before). Returns lift_to_use following the rule: SKU's own average, else brand average, else 1.5x default.",
      inputSchema: z.object({ sku }),
      annotations: READ_ONLY,
    },
    async ({ sku }) =>
      run(async () => {
        const [product] = await sql`select sku, brand_id from products where sku = ${sku}`;
        if (!product) throw new Error(`Unknown SKU ${sku}`);
        const [own, brand, upcoming] = await Promise.all([
          sql`select start_date::text as start_date, end_date::text as end_date, discount_pct::float8 as discount_pct,
                promo_avg_units::float8 as promo_avg_units, baseline_units::float8 as baseline_units, baseline_source, lift::float8 as lift
              from v_promo_lift where sku = ${sku} and lift is not null order by start_date`,
          sql`select count(*)::int as promos, round(avg(lift), 2)::float8 as avg_lift
              from v_promo_lift where brand_id = ${product.brand_id} and lift is not null`,
          sql`select pr.start_date::text as start_date, pr.end_date::text as end_date, pr.discount_pct::float8 as discount_pct, pr.funded_by
              from promos pr where pr.sku = ${sku}
                and pr.start_date > (select value::date from planning_config where key = 'as_of_date')
              order by pr.start_date`,
        ]);
        const ownAvg = own.length ? Math.round((own.reduce((s, r) => s + Number(r.lift), 0) / own.length) * 100) / 100 : null;
        const brandAvg = brand[0]?.promos ? Number(brand[0].avg_lift) : null;
        const lift_to_use = ownAvg ?? brandAvg ?? DEFAULT_PROMO_LIFT;
        const lift_source = ownAvg != null ? "sku_history" : brandAvg != null ? "brand_average" : "default_1.5x";
        return {
          sku,
          upcoming_promos: upcoming,
          sku_past_promos: own,
          sku_average_lift: ownAvg,
          brand_past_promos: brand[0]?.promos ?? 0,
          brand_average_lift: brandAvg,
          lift_to_use,
          lift_source,
        };
      }),
  );

  server.registerTool(
    "list_upcoming_promos",
    {
      title: "Upcoming promos",
      description: "All promos starting after the planning date, optionally for one LP, with each SKU's current stock position.",
      inputSchema: z.object({ lp_id: lpId.optional() }),
      annotations: READ_ONLY,
    },
    async ({ lp_id }) =>
      run(
        () => sql`
          select pr.sku, m.name, m.brand, m.lp_id, pr.start_date::text as start_date, pr.end_date::text as end_date,
            pr.discount_pct::float8 as discount_pct, pr.funded_by,
            m.baseline_velocity::float8 as baseline_velocity, m.wsoh_now::float8 as wsoh_now,
            m.projected_wsoh_at_arrival::float8 as projected_wsoh_at_arrival
          from promos pr join v_sku_metrics m on m.sku = pr.sku
          where pr.start_date > (select value::date from planning_config where key = 'as_of_date')
            and (${lp_id ?? null}::int is null or m.lp_id = ${lp_id ?? null}::int)
          order by pr.start_date, m.lp_id, pr.sku`,
      ),
  );

  server.registerTool(
    "list_overstock",
    {
      title: "Overstock",
      description:
        "SKUs with more than min_wsoh weeks of stock (default 8), plus SKUs holding stock with no sales at all (zero baseline velocity), including delisted ones. New and upcoming launches are left out. Input for the aging agent.",
      inputSchema: z.object({
        lp_id: lpId.optional(),
        min_wsoh: z.number().positive().default(8).describe("Weeks of stock threshold (default 8)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ lp_id, min_wsoh }) =>
      run(async () => {
        const rows = await sql`
          select sku, name, brand, lp_id, lp_name, category, status, lifecycle,
            baseline_velocity::float8 as baseline_velocity, on_hand_units::int as on_hand_units, open_po_units::int as open_po_units,
            wsoh_now::float8 as wsoh_now, next_promo_start::text as next_promo_start, is_limited_edition
          from v_sku_metrics
          where lifecycle in ('established', 'delisted')
            and (${lp_id ?? null}::int is null or lp_id = ${lp_id ?? null}::int)
            and (wsoh_now > ${min_wsoh}
                 or (on_hand_units + open_po_units > 0 and coalesce(baseline_velocity, 0) = 0))
          order by wsoh_now desc nulls first, sku`;
        return { min_wsoh, sku_count: rows.length, skus: rows };
      }),
  );

  server.registerTool(
    "list_open_purchase_orders",
    {
      title: "Open purchase orders",
      description: "Open POs with expected delivery dates and lines (stock and flow-through), optionally for one LP.",
      inputSchema: z.object({ lp_id: lpId.optional() }),
      annotations: READ_ONLY,
    },
    async ({ lp_id }) =>
      run(
        () => sql`
          select o.po_number, o.lp_id, l.name as lp_name, o.order_date::text as order_date,
            o.expected_delivery::text as expected_delivery,
            json_agg(json_build_object('sku', pl.sku, 'qty', pl.qty, 'order_type', pl.order_type, 'store_id', pl.store_id)
                     order by pl.sku) as lines
          from purchase_orders o
          join lps l on l.id = o.lp_id
          join po_lines pl on pl.po_number = o.po_number
          where o.status = 'open' and (${lp_id ?? null}::int is null or o.lp_id = ${lp_id ?? null}::int)
          group by o.po_number, l.name
          order by o.expected_delivery, o.lp_id`,
      ),
  );

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description: "Find SKUs by name, SKU, brand, LP, category or lifecycle. Returns up to `limit` rows with key metrics.",
      inputSchema: z.object({
        query: z.string().max(80).optional().describe("Text to match in SKU, product name or brand"),
        lp_id: lpId.optional(),
        category: z.enum(["flower", "pre-roll", "vape", "edible", "beverage", "extract", "topical"]).optional(),
        lifecycle: z.enum(["upcoming_launch", "new_launch", "established", "delisted"]).optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, lp_id, category, lifecycle, limit }) =>
      run(() => {
        const pattern = query ? `%${query}%` : null;
        return sql`
          select sku, name, brand, lp_id, lp_name, category, size, lifecycle, status,
            baseline_velocity::float8 as baseline_velocity, wsoh_now::float8 as wsoh_now, on_hand_units::int as on_hand_units
          from v_sku_metrics
          where (${pattern}::text is null or sku ilike ${pattern} or name ilike ${pattern} or brand ilike ${pattern})
            and (${lp_id ?? null}::int is null or lp_id = ${lp_id ?? null}::int)
            and (${category ?? null}::text is null or category = ${category ?? null}::text)
            and (${lifecycle ?? null}::text is null or lifecycle = ${lifecycle ?? null}::text)
          order by sku
          limit ${limit}`;
      }),
  );
}
