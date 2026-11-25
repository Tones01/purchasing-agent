import { z } from "zod";
import type { createMcpHandler } from "mcp-handler";
import { withDb, type Sql } from "./db";

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
  // Compact JSON: about 25% fewer tokens than pretty-printed.
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}


function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// Minimal CSV writer: quotes fields containing commas, quotes or newlines; arrays joined with "|".
function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = Array.isArray(v) ? v.join("|") : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n");
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

type Cols = ReturnType<Sql["unsafe"]>;

// Runs one tool call on its own short-lived connection (see lib/db.ts).
async function run(fn: (sql: Sql, cols: Cols) => Promise<unknown>) {
  try {
    return ok(await withDb((sql) => fn(sql, sql.unsafe(METRIC_COLS))));
  } catch (err) {
    console.error(err);
    return fail(err instanceof Error ? err.message : "Unexpected error");
  }
}

const sku = z.string().regex(/^SKU-\d{5}$/, "SKU format is SKU-00000").describe("Product SKU, e.g. SKU-00123");
const lpId = z.number().int().positive().describe("LP id from list_lps");

export function registerTools(server: Server) {
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
      run(async (sql, cols) => {
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
        (sql) => sql`
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
      run(async (sql, cols) => {
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
      run(async (sql, cols) => {
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
      run(async (sql, cols) => {
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
      run(async (sql, cols) => {
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
        (sql) => sql`
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
        "SKUs with more than min_wsoh weeks of stock (default 8), plus SKUs holding stock with no sales at all (zero baseline velocity), including delisted ones. New and upcoming launches are left out. Input for the aging agent. Paged: returns a summary of all matches (by WSOH band) plus up to `limit` rows from `offset`. Filter by lp_id to keep results small.",
      inputSchema: z.object({
        lp_id: lpId.optional(),
        min_wsoh: z.number().positive().default(8).describe("Weeks of stock threshold (default 8)"),
        limit: z.number().int().min(1).max(100).default(50).describe("Rows per page (default 50, max 100)"),
        offset: z.number().int().min(0).default(0).describe("Rows to skip, for the next page"),
      }),
      annotations: READ_ONLY,
    },
    async ({ lp_id, min_wsoh, limit, offset }) =>
      run(async (sql, cols) => {
        const lp = lp_id ?? null;
        const match = sql`
          from v_sku_metrics
          where lifecycle in ('established', 'delisted')
            and (${lp}::int is null or lp_id = ${lp}::int)
            and (wsoh_now > ${min_wsoh}
                 or (on_hand_units + open_po_units > 0 and coalesce(baseline_velocity, 0) = 0))`;
        const [[summary], rows] = await Promise.all([
          sql`select count(*)::int as total,
                count(*) filter (where wsoh_now > 8 and wsoh_now <= 10)::int as wsoh_8_to_10,
                count(*) filter (where wsoh_now > 10 and wsoh_now <= 13)::int as wsoh_10_to_13,
                count(*) filter (where wsoh_now > 13 and wsoh_now <= 17)::int as wsoh_13_to_17,
                count(*) filter (where wsoh_now > 17 and wsoh_now <= 26)::int as wsoh_17_to_26,
                count(*) filter (where wsoh_now > 26)::int as wsoh_over_26,
                count(*) filter (where wsoh_now is null or coalesce(baseline_velocity, 0) = 0)::int as no_sales_with_stock
              ${match}`,
          sql`select sku, name, brand, lp_id, category, status, lifecycle,
                baseline_velocity::float8 as baseline_velocity, on_hand_units::int as on_hand_units, open_po_units::int as open_po_units,
                wsoh_now::float8 as wsoh_now, next_promo_start::text as next_promo_start, is_limited_edition
              ${match}
              order by wsoh_now desc nulls first, sku
              limit ${limit} offset ${offset}`,
        ]);
        const nextOffset = offset + rows.length < summary.total ? offset + rows.length : null;
        return { min_wsoh, summary, offset, returned: rows.length, next_offset: nextOffset, skus: rows };
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
        (sql) => sql`
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
      run((sql) => {
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

  server.registerTool(
    "get_purchase_plan_summary",
    {
      title: "Purchase plan summary",
      description:
        "Start of the weekly review. The purchase plan is calculated by the rules engine in the database (trigger, target, promo forward buy, launch quantities, case pack rounding, urgent flag, aging buckets). Returns totals by decision, PO totals by LP (lines, units, cost, urgent, lines needing review), aging counts by bucket, and counts of each review flag.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      run(async (sql) => {
        // One round trip: the plan is calculated once and every summary is built from it.
        const [row] = await sql`
          with p as materialized (select * from v_purchase_plan)
          select
            (select coalesce(json_agg(x order by x.decision), '[]') from (
              select decision, count(*)::int as skus, coalesce(sum(order_qty), 0)::int as units,
                round(sum(line_cost)::numeric, 2)::float8 as cost,
                count(*) filter (where cardinality(review_flags) > 0)::int as needs_review
              from p group by decision) x) as by_decision,
            (select coalesce(json_agg(x order by x.cost desc), '[]') from (
              select lp_id, lp_name, count(*)::int as po_lines, sum(order_qty)::int as units,
                round(sum(line_cost)::numeric, 2)::float8 as cost,
                count(*) filter (where urgent)::int as urgent_lines,
                count(*) filter (where cardinality(review_flags) > 0)::int as lines_needing_review
              from p where decision = 'reorder' group by lp_id, lp_name) x) as purchase_orders_by_lp,
            (select coalesce(json_agg(x order by x.aging_bucket, x.aging_action), '[]') from (
              select aging_bucket, aging_action, aging_owner, count(*)::int as skus
              from p where decision = 'aging' group by aging_bucket, aging_action, aging_owner) x) as aging_actions,
            (select coalesce(json_agg(x order by x.skus desc), '[]') from (
              select flag, count(*)::int as skus from p, unnest(review_flags) as flag group by flag) x) as review_flags`;
        return row;
      }),
  );

  server.registerTool(
    "get_purchase_plan",
    {
      title: "Purchase plan lines",
      description:
        "Line-level purchase plan from the rules engine. Each line has the decision (reorder, no_reorder, aging, review), the velocity used and its source, target weeks and why, promo lift and extra units, raw and rounded order quantity with the rounding note, weeks of stock after the order, line cost, urgent flag, aging bucket/action/owner, and review_flags. Filter by LP, decision, or only lines with review flags. Paged.",
      inputSchema: z.object({
        lp_id: lpId.optional(),
        decision: z.enum(["reorder", "no_reorder", "aging", "review"]).optional(),
        needs_review_only: z.boolean().default(false).describe("Only lines with at least one review flag"),
        flag: z
          .enum(["urgent", "promo", "new_launch", "upcoming_launch", "no_similar_products", "case_pack_overshoot",
                 "limited_edition_low", "no_sales_with_stock", "bucket_5"])
          .optional()
          .describe("Only lines carrying this review flag"),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
      annotations: READ_ONLY,
    },
    async ({ lp_id, decision, needs_review_only, flag, limit, offset }) =>
      run(async (sql) => {
        const lp = lp_id ?? null;
        const dec = decision ?? null;
        const fl = flag ?? null;
        const where = sql`
          where (${lp}::int is null or lp_id = ${lp}::int)
            and (${dec}::text is null or decision = ${dec}::text)
            and (not ${needs_review_only}::boolean or cardinality(review_flags) > 0)
            and (${fl}::text is null or ${fl}::text = any(review_flags))`;
        const [[count], rows] = await Promise.all([
          sql`select count(*)::int as total from v_purchase_plan ${where}`,
          sql`select sku, name, brand, lp_id, category, size, lifecycle, decision,
                plan_velocity, velocity_source, similar_count, trend_pct, is_top_seller,
                on_hand_units, open_po_units, wsoh_now, target_weeks, target_reason,
                promo_start, promo_lift, lift_source, promo_extra_units,
                raw_qty, case_pack, order_qty, rounding_note, wsoh_after_order, line_cost,
                urgent, aging_bucket, aging_action, aging_owner, review_flags
              from v_purchase_plan ${where}
              order by lp_id, decision, urgent desc, sku
              limit ${limit} offset ${offset}`,
        ]);
        const nextOffset = offset + rows.length < count.total ? offset + rows.length : null;
        return { total: count.total, offset, returned: rows.length, next_offset: nextOffset, lines: rows };
      }),
  );

  server.registerTool(
    "get_partner_health",
    {
      title: "LP and brand health",
      description:
        "Health check per LP and per brand, calculated by code: active SKUs, PO lines/units/cost, urgent lines, SKUs over 8 weeks, aged stock value in buckets 4-5, dead stock, case pack issues, stockouts, a severity score and rank, plain-language trouble_reasons, and is_trouble (top 5 LPs and top 8 brands that have at least one trouble reason). Use it for the executive summary's trouble list.",
      inputSchema: z.object({
        level: z.enum(["lp", "brand", "both"]).default("both"),
        trouble_only: z.boolean().default(true).describe("Only rows marked is_trouble (default true)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ level, trouble_only }) =>
      run(async (sql) => {
        const lv = level === "both" ? null : level;
        const rows = await sql`
          select level, lp_id, brand_id, name, lp_name, severity_rank::int as severity_rank, severity_score, is_trouble,
            trouble_reasons, active_skus, reorder_lines, po_units, po_cost, urgent_lines, over_8_wks_skus,
            aged_value_b4_b5, dead_stock_skus, case_pack_issues, stockout_skus, review_lines
          from v_partner_health
          where (${lv}::text is null or level = ${lv}::text)
            and (not ${trouble_only}::boolean or is_trouble)
          order by level desc, severity_rank, name`;
        return { rows };
      }),
  );

  server.registerTool(
    "export_purchase_plan",
    {
      title: "Export purchase plan (CSV)",
      description:
        "Compact CSV export of one section of the plan, for building the workbook. Every line carries a standard reason written by code. Sections: po_lines (all reorder lines, grouped by LP), review (every line with a review flag, plus review decisions), aging (all aging actions), no_reorder (SKUs within 6 to 8 weeks or limited editions). Optional lp_id. Returns CSV text, header row first.",
      inputSchema: z.object({
        section: z.enum(["po_lines", "review", "aging", "no_reorder"]),
        lp_id: lpId.optional(),
      }),
      annotations: READ_ONLY,
    },
    async ({ section, lp_id }) => {
      try {
        const csv = await withDb(async (sql) => {
          const lp = lp_id ?? null;
          const byLp = sql`(${lp}::int is null or lp_id = ${lp}::int)`;
          if (section === "po_lines") {
            const rows = await sql`select lp_name, sku, name, brand, category, size, order_qty, case_pack, cases,
                unit_cost, line_cost, wsoh_now, wsoh_after_order, urgent, review_flags, reason
              from v_plan_export where decision = 'reorder' and ${byLp} order by lp_name, urgent desc, sku`;
            return toCsv(rows, ["lp_name", "sku", "name", "brand", "category", "size", "order_qty", "case_pack", "cases",
              "unit_cost", "line_cost", "wsoh_now", "wsoh_after_order", "urgent", "review_flags", "reason"]);
          }
          if (section === "review") {
            const rows = await sql`select lp_name, sku, name, brand, lifecycle, decision, review_flags, wsoh_now, plan_velocity,
                similar_count, promo_start, promo_lift, lift_source, promo_extra_units, order_qty, case_pack, line_cost, reason
              from v_plan_export where (cardinality(review_flags) > 0 or decision = 'review') and ${byLp}
              order by lp_name, sku`;
            return toCsv(rows, ["lp_name", "sku", "name", "brand", "lifecycle", "decision", "review_flags", "wsoh_now",
              "plan_velocity", "similar_count", "promo_start", "promo_lift", "lift_source", "promo_extra_units", "order_qty",
              "case_pack", "line_cost", "reason"]);
          }
          if (section === "aging") {
            const rows = await sql`select lp_name, sku, name, brand, status, wsoh_now, on_hand_units, open_po_units,
                aging_bucket, aging_action, aging_owner, aged_value, promo_start, reason
              from v_plan_export where decision = 'aging' and ${byLp} order by aging_bucket desc, aged_value desc, sku`;
            return toCsv(rows, ["lp_name", "sku", "name", "brand", "status", "wsoh_now", "on_hand_units", "open_po_units",
              "aging_bucket", "aging_action", "aging_owner", "aged_value", "promo_start", "reason"]);
          }
          const rows = await sql`select lp_name, sku, name, brand, wsoh_now, is_limited_edition, reason
            from v_plan_export where decision = 'no_reorder' and ${byLp} order by lp_name, sku`;
          return toCsv(rows, ["lp_name", "sku", "name", "brand", "wsoh_now", "is_limited_edition", "reason"]);
        });
        return okText(csv);
      } catch (err) {
        console.error(err);
        return fail(err instanceof Error ? err.message : "Unexpected error");
      }
    },
  );
}
