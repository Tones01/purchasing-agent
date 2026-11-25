# Purchasing Agent: MCP Server

Read-only tools for a team of AI agents that drafts weekly purchase orders for a fictional cannabis wholesale distributor. A person approves every PO. All data is made up and randomized.

This is part one of a portfolio project on AI operations: building agent tools, keeping them safe, and measuring whether they work.

## How it fits together

```
Claude / agent SDK  ──>  MCP server (this repo, on Vercel)  ──>  Supabase Postgres (read-only role)
```

**Hybrid design: code runs the rules, AI handles judgment.**

- **Code (database views):** sales speed, trend, weeks of stock, promo lift, and the full purchase plan: reorder trigger, target weeks, promo forward buy, launch quantities from similar products, case pack rounding, urgent flag, aging buckets. Same input, same answer, every time, at $0 per run.
- **AI (agents):** reviews only the lines the engine flags (urgent, promo, new launch, no similar products, oversized case pack, limited edition, dead stock), writes the plain-English reason on each line, routes aging actions, and answers the approver's questions.

This keeps runs cheap, makes the math testable with ordinary checks, and points the evals at the judgment calls.

All database code is in [`supabase/migrations`](supabase/migrations). The purchase plan engine is [`0005_purchase_plan_engine.sql`](supabase/migrations/0005_purchase_plan_engine.sql).

## Tools

| Tool | What it returns | Main user |
|---|---|---|
| `get_partner_health` | LP and brand health: urgent lines, overstock, aged stock $, dead stock, trouble reasons, severity rank | Exec summary |
| `export_purchase_plan` | Compact CSV of PO lines, review lines or aging, each with a standard reason written by code | Workbook builder |
| `get_purchase_plan_summary` | Plan totals by decision, PO totals by LP, aging actions, review flag counts | Orchestrator |
| `get_purchase_plan` | Plan lines with decision, quantities, rounding, cost, urgent, aging and review flags (paged, filterable) | All agents |
| `get_planning_context` | Planning date, history window, lead time, metric definitions | Orchestrator |
| `list_lps` | Suppliers with lead times, brands, active SKUs, open POs | Orchestrator |
| `get_lp_stock_overview` | Per-SKU sales speed, trend, top seller flag, stock, weeks on hand now and at arrival | Demand + supply agents |
| `get_sku_detail` | 26-week history with promo / post-promo / stockout flags, promos, open PO lines | Any agent, for checking |
| `find_similar_products` | Same brand + category comparables for new launches | Demand agent |
| `get_promo_lift` | Past lift and the lift to use (SKU, then brand, then 1.5x) | Promo agent |
| `list_upcoming_promos` | Promos starting after the planning date | Promo agent |
| `list_overstock` | SKUs over 8 weeks of stock, plus dead stock | Aging agent |
| `list_open_purchase_orders` | Open POs and lines | Supply agent |
| `search_products` | Find SKUs by name, brand, LP, category, lifecycle | Anyone |

## Metric definitions

- **Baseline velocity:** average weekly units over the last 12 weeks (or since launch), leaving out promo weeks, the week after each promo, stockout weeks and flow-through units.
- **Trend:** last 4 weeks vs the 12-week baseline (same exclusions).
- **Top seller:** top 20% of established SKUs by 12-week revenue.
- **Weeks of stock now:** (on hand + open POs) / baseline velocity.
- **Projected at arrival:** stock left when a PO placed today lands (planned at end of week 2), in units and weeks.
- **Promo lift:** promo-week units / the 4 normal weeks before the promo.

## Skill

[`skills/weekly-purchase-plan/SKILL.md`](skills/weekly-purchase-plan/SKILL.md) is the playbook Claude follows to turn the engine's draft into an approvable plan: 6 tool calls, a recommendation and owner on every flagged line, aging handoffs by team, an Excel workbook (Summary, PO Lines, Review, Aging, Notes) and a short executive summary naming trouble LPs and brands. Tested end to end against the live server: 155 formulas, zero errors, totals and row counts matching the exports. One full run pulls about 40K tokens of tool output.

## Rule checks (current run)

Every rule is checked across every SKU, not a sample. All pass:

- Order quantities are whole case packs
- Reorders land between 6 and 8 weeks (plus promo weeks), unless the case pack is too large (flagged)
- 6 to 8 weeks with no promo: no reorder. Under 6: reorder. Over 8: aging, never reorder
- Targets: top seller 8, trending up 8, slowing 6, flat 7. Launches: 6 off similar products
- Launches with no similar products are flagged; upcoming launches are always listed
- Limited editions, delisted SKUs and flow-through-only SKUs are never reordered
- Promo extra units = (lift - 1) x velocity x promo weeks, always flagged
- Aging bucket matches the weeks-of-stock band

## Reliability

- One short-lived database connection per tool call. Serverless functions freeze between requests, and long-lived connections die during the freeze and hang the next call.
- 20-second query timeout inside the server, so a stuck call fails fast with a clear error.

## Security

- **Read-only database role.** The database role (`mcp_reader`) can only `SELECT`. It's locked to read-only transactions and has a 15-second statement timeout.
- **Hidden answer key.** Eval answer data lives in a separate schema this role cannot see.
- **Key required.** Every request needs the shared key, sent as `Authorization: Bearer <key>` or `?key=<key>`. Keys are compared in constant time.
- **Read-only annotations.** Every tool is marked read-only for MCP clients.

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL and MCP_API_KEY
npm run dev
```

Endpoint: `http://localhost:3000/api/mcp` (Streamable HTTP).

## Stack

Next.js 16, `mcp-handler` 2.x (MCP SDK v2), Postgres via `postgres`, Supabase, Vercel.
