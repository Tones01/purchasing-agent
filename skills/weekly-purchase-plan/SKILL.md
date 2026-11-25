---
name: weekly-purchase-plan
description: Build the weekly purchase plan review from the Purchasing Agent MCP server - an Excel workbook (POs by LP, flagged lines with recommendations, aging handoffs) plus a short executive summary that names trouble LPs and brands. Use when asked for the purchase plan, a PO review, reorder recommendations, or a purchasing workbook.
---

# Weekly purchase plan review

You turn the rules engine's draft plan into a clean, approvable purchase plan. The engine (database code behind the Purchasing Agent MCP server) has already done every calculation: reorder trigger, target weeks, promo forward buy, launch quantities, case pack rounding, urgent flag, aging buckets, LP/brand health, and a standard reason on every line.

**Your job is judgment, not math:** review the flagged lines, write short recommendations, name the trouble LPs and brands, and package it for the approver.

## Hard rules

- **Use only numbers the tools return.** Never calculate, estimate or adjust a quantity, cost or weeks-of-stock figure yourself. If a number looks wrong, say so in a note; don't fix it.
- **Never say a PO was sent, placed or approved.** Everything is a draft for the approver.
- **Don't invent SKUs, LPs, brands, promos or dates.** If something is missing, write "not in data".
- **If a tool errors, retry once, then tell the user** which part is missing. Don't fill the gap.
- **Keep it short and scannable.** Notes are 12 words or fewer. No filler.

## Steps

### 1. Pull the plan (5 tool calls)

1. `get_planning_context`: note the planning date for the file name and headers.
2. `get_purchase_plan_summary`: totals by decision, POs by LP, aging actions, review flag counts.
3. `get_partner_health` (defaults: both levels, trouble only): the trouble list.
4. `export_purchase_plan` with `section: "po_lines"`, then `"review"`, then `"aging"`. Each returns CSV. Load them straight into the workbook code; don't retype rows.

Only pull `no_reorder` if the user asks. Use `get_sku_detail`, `find_similar_products` or `search_products` only to check a specific flagged line.

### 2. Review every flagged line

For each row in the `review` export, write a **Recommendation** (12 words max) and an **Action owner**, using the line's flags:

| Flag | What to recommend |
|---|---|
| `urgent` | "Ask LP to expedite" (if an open PO exists, "chase open PO" instead). Owner: purchasing |
| `promo` | If `lift_source` is `default_1.5x`: "Confirm expected lift with sales". If lift is over 3x: "Lift looks high, confirm before buying". Otherwise: "OK, forward buy covers promo". Owner: purchasing |
| `new_launch`, `upcoming_launch` | "Confirm launch date and first order with LP". If `similar_count` is 1: "Only 1 comparable, start conservative". Owner: purchasing |
| `no_similar_products` | "No comparables: suggest 2 cases, approver to confirm". Owner: approver |
| `case_pack_overshoot` | "Ask LP for smaller order multiple" (top sellers: "Accept, top seller absorbs overstock"). Owner: purchasing |
| `limited_edition_low` | "Can't reorder; feature a same-brand substitute". Use `search_products` (same brand + category, established) to name one SKU if you can. Owner: marketing |
| `no_sales_with_stock` | "Dead stock: clearance or LP return". Owner: approver |
| `bucket_5` | "Over 26 weeks: clearance or LP return conversation". Owner: approver |

If a line has several flags, lead with the most serious: urgent, then no_similar_products, then dead stock, then the rest.

### 3. Turn aging into handoffs

From the `aging` export, group by `aging_owner`. Each owner gets one short handoff line on the Aging tab:
- **Marketing:** "Feature these N SKUs in this week's catalogue and email"
- **Sales:** "Ask these LPs for supplier-funded promos: ..."
- **Purchasing + approver:** "Markdown candidates: N SKUs, $X aged value"
- **Approver:** "Clearance or return conversations: N SKUs, $X"

Use the counts and dollar totals from the export. Don't recompute values that are already in it.

### 4. Build the workbook

Follow [references/workbook-layout.md](references/workbook-layout.md) exactly. Use code (openpyxl) and the xlsx skill if it's available. Name the file `Purchase_Plan_<planning date>.xlsx`.

### 5. Write the executive summary (in chat, and on the Summary tab)

Short and scannable, in this order:

1. **One line:** "Week of <date>: <N> PO lines across <N> LPs, <units> units, $<cost>. <N> urgent."
2. **Trouble LPs** (from `get_partner_health`, `is_trouble`, in rank order): one line each, name plus its trouble reasons.
3. **Trouble brands:** same format.
4. **Top 3 actions this week:** your judgment, each 12 words or fewer, naming the LP or brand. Pick from urgent stock-outs, the biggest aged-stock dollars, and launches needing confirmation.
5. **Needs the approver:** count of review lines and where to find them (Review tab).

No other sections. Don't repeat every line in chat; that's what the workbook is for.

## Definitions

See [references/rules.md](references/rules.md) for every rule the engine applies. Use it to answer "why this quantity?" questions, quoting the line's own numbers.
