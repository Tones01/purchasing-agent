# Purchasing Agent: MCP Server

Read-only tools for a team of AI agents that drafts weekly purchase orders for a fictional cannabis wholesale distributor. A person approves every PO. All data is made up and randomized.

This is part one of a portfolio project on AI operations: building agent tools, keeping them safe, and measuring whether they work.

## How it fits together

```
Claude / agent SDK  ──>  MCP server (this repo, on Vercel)  ──>  Supabase Postgres (read-only role)
```

- **Agents decide.** Reorder triggers, targets, rounding, promo buys, aging actions and the written reasons.
- **Code calculates.** Sales speed, trend, weeks of stock and promo lift are calculated in database views, so agents never do arithmetic over hundreds of rows. That makes the results cheaper and repeatable, and you can test them.

## Tools

| Tool | What it returns | Main user |
|---|---|---|
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
