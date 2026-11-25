---
name: weekly-purchase-plan
description: Build the weekly purchase plan review from the Purchasing Agent MCP server: Excel workbook plus a short executive summary naming trouble LPs and brands. Use for purchase plans, PO reviews or reorder recommendations.
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

## Step 1. Pull the plan (6 tool calls)

1. `get_planning_context`: the planning date, for the file name and headers.
2. `get_purchase_plan_summary`: totals by decision, POs by LP, aging actions, review flag counts.
3. `get_partner_health` (defaults: both levels, trouble only): the trouble list.
4. `export_purchase_plan` with `section` set to `po_lines`, then `review`, then `aging`. Each returns CSV. Load it straight into the workbook code; don't retype rows.

Only pull `no_reorder`, or aging with `include_watch: true`, if the user asks. Use `get_sku_detail`, `find_similar_products` or `search_products` only to check a specific flagged line.

## Step 2. Review every flagged line

For each row in the `review` export, write a **Recommendation** (12 words max) and an **Action owner**, using the line's flags:

| Flag | Recommendation | Owner |
|---|---|---|
| `urgent` | "Ask LP to expedite" | purchasing |
| `promo` | If `lift_source` is `default_1.5x`: "Confirm expected lift with sales". If lift is over 3x: "Lift looks high, confirm before buying". Otherwise: "OK, forward buy covers promo" | purchasing |
| `new_launch`, `upcoming_launch` | "Confirm launch date and first order with LP". If `similar_count` is 1: "Only 1 comparable, start conservative" | purchasing |
| `no_similar_products` | "No comparables: suggest 2 cases, approver to confirm" | approver |
| `case_pack_overshoot` | "Ask LP for smaller order multiple" | purchasing |
| `limited_edition_low` | "Can't reorder; feature substitute <SKU name>" (find one with `search_products`: same brand and `category`, lifecycle established, at least 4 weeks of stock, highest velocity). If none: "Can't reorder; no same-brand substitute in stock" | marketing |
| `no_sales_with_stock` | "Dead stock: clearance or LP return" | approver |
| `bucket_5` | "Over 26 weeks: clearance or LP return conversation" | approver |

If a line has several flags, lead with the most serious: urgent, then no_similar_products, then dead stock (no_sales_with_stock, bucket_5), then the rest.

Set **Priority** to `High` when the line must be decided before POs go out: lead flag urgent, no_similar_products or case_pack_overshoot. Everything else is `Normal`. Dead stock (no_sales_with_stock, bucket_5) is Normal here because the Aging tab handles it as one bulk clearance decision.

## Step 3. Turn aging into handoffs

From the `aging` export, group by `aging_owner`. Each owner gets one handoff line, using counts and dollar totals from the export:
- **marketing:** "Feature these N SKUs in this week's catalogue and email"
- **sales:** "Ask N LPs for supplier-funded promos on N SKUs"
- **purchasing + approver:** "Markdown candidates: N SKUs, $X aged value"
- **approver:** "Clearance or return conversations: N SKUs, $X aged value"

## Step 4. Build the workbook

Use code (openpyxl) and the xlsx skill if it's available. File name: `Purchase_Plan_<planning date>.xlsx`. Arial 10 throughout, bold header rows with a light grey fill, freeze the header row, autofilter on every data tab except PO Lines, sensible column widths (reason and notes columns max 60, wrapped). Tabs in this order, exact names:

### Summary
- A1 `Purchase Plan: week of <planning date>` (bold, 14pt). A2 `Draft for approval. Nothing has been sent to LPs.`
- **Key numbers** (label in A, value in B), all formulas, never typed numbers:
  - PO lines `=COUNTIF('PO Lines'!A:A,"SKU-*")`
  - Draft POs: `COUNTA` over the Draft POs by LP table's Draft PO column
  - Units and Cost (format `$#,##0`): `SUM` over the Draft POs by LP table's Units and Cost columns
  - Urgent lines `=COUNTIF('PO Lines'!K:K,TRUE)`
  - Lines needing review `=COUNTA(Review!B:B)-1`
  - High-priority review lines: `COUNTIF` on the Review tab's Priority column for "High"
- **Executive summary:** the step 5 summary, one item per row (wrap text).
- **Trouble LPs:** LP, Rank, Severity, Trouble reasons (joined with "; ", wrapped), PO cost, Urgent lines, Aged value (b4-5).
- **Trouble brands:** Brand, Rank, Severity, Trouble reasons (wrapped), LP, Urgent lines, Aged value (b4-5).
- Summary column widths: A 30, B 12, C 12, D 70, E 24, F 13, G 17. Every table starts in column A, so the reasons always sit in the wide column D.
- **Draft POs by LP:** LP, Draft PO, ETA, Lines, Units, Cost, Urgent. One row per PO block, in the same order as the PO Lines tab (largest first). Lines and Urgent count that block's rows; Units and Cost link to that block's subtotal cells.

### PO Lines
One block per draft PO, in export order (the export is already sorted largest PO first, urgent lines first within each PO). Header row 1 (frozen): `SKU, Product, Brand, Units, Case pack, Cases, Unit cost, Line cost, Wks now, Wks after, Urgent, Flags, Reason, Approve (Y/N), Approver notes` (columns A to O). No autofilter on this tab; it would break the blocks. For each `draft_po`:
- **PO header row** (bold, light blue fill across A to O): A `draft_po`, B `lp_name`, C `Lead <lead_time_weeks> wks  |  ETA <expected_delivery>`
- **Line rows:** sku, name, brand, order_qty, case_pack, cases, unit_cost, line_cost, wsoh_now, wsoh_after_order, urgent (TRUE/FALSE), review_flags, reason. Approve and notes cells blank with a yellow fill. Urgent rows get a light red fill. Costs `$#,##0.00`, weeks `0.0`, reason wrapped.
- **Subtotal row** (bold, light grey fill): A `Subtotal`, B line count, D `=SUM` of units, F `=SUM` of cases, H `=SUM` of line cost, K count of urgent lines.
- One blank row before the next PO.
Column widths: A 16, B 34, C 22, D 8, E 10, F 7, G 10, H 12, I 8, J 9, K 8, L 22, M 60, N 14, O 30.

### Review
All `review` rows, plus `Priority`, `Recommendation`, `Action owner`, and `Approver decision` (blank, yellow fill). Sort: High priority first (urgent, then no_similar_products, then case packs), then Normal by LP. Autofilter so the approver can show High only.

### Aging
One handoff line per owner at the top (bold owner in A, text in B), a blank row, then all `aging` rows with headers. `aged_value` as `$#,##0`.

### Notes
- What each tab is for; yellow cells are for the approver
- Weeks of stock = (on hand + open POs) / baseline weekly sales
- Targets: top seller or trending up 8 weeks, flat 7, slowing 6, launches 6
- Bucket 1 (8 to 10 weeks, watch) is left off the Aging tab
- Source: Purchasing Agent MCP server, planning date <date>. All figures from the rules engine.

### Checks before handing over
- Recalculate; zero formula errors.
- Summary cost equals the sum of `line_cost` in the po_lines export.
- Row counts match the exports: PO Lines lines, Review and Aging; one PO block per distinct `draft_po`.

## Step 5. Write the executive summary (in chat and on the Summary tab)

Short and scannable, in this order:
1. **One line:** "Week of <date>: <N> draft POs (one per LP), <N> lines, <units> units, $<cost>. <N> urgent."
2. **Trouble LPs** (`is_trouble`, in rank order): one line each, name plus its trouble reasons.
3. **Trouble brands:** same format.
4. **Top 3 actions this week:** your judgment, 12 words or fewer each, naming the LP or brand. Pick from urgent stock-outs, the biggest aged-stock dollars, and launches needing confirmation.
5. **Needs the approver:** "<N> high-priority lines to decide (of <N> flagged), on the Review tab."

No other sections. Don't repeat every line in chat; that's what the workbook is for.

## Rules reference (for "why this quantity?")

Quote the line's own numbers; never recompute them.

1. **Baseline velocity:** average weekly units, last 12 weeks (or since launch), leaving out promo weeks, the week after each promo, stockout weeks and flow-through. Under 3 weeks of sales = new launch.
2. **Weeks of stock:** (on hand + all open POs) / baseline velocity, measured today. New POs planned to land at the end of week 2.
3. **Reorder:** under 6 weeks, or under 6 weeks plus an upcoming promo's extra units. Over 8 weeks with no promo goes to aging. **Urgent:** under 2 weeks of stock left by the time a new PO could land.
4. **Target:** top seller (top 20% by 12-week revenue) 8 weeks; trending up (last 4 weeks over 10% above baseline) 8; slowing (over 10% below) 6; flat 7. Order = target x velocity + promo extra - (on hand + open POs).
5. **Rounding:** whole case packs. Round up unless that passes 8 weeks (plus promo weeks), then down unless that drops under 6; if neither works, round up and flag `case_pack_overshoot`.
6. **Launches:** always listed; 6 weeks at the average velocity of established same brand + category SKUs. None: `review` + `no_similar_products`.
7. **Promos:** extra = (lift - 1) x velocity x promo weeks. Lift from the SKU's past promos, then brand average, then 1.5x; measured against the 4 normal weeks before the promo. **Limited editions** are never reordered.
8. **Flow-through:** bought for one retailer order and shipped straight out; never in velocity, never a reorder.
9. **Approval:** no spend limit; one approver signs off everything.
10. **Aging buckets:** 1: 8 to 10 watch · 2: 10 to 13 feature (marketing) · 3: 13 to 17 LP-funded promo (sales) · 4: 17 to 26 markdown (purchasing + approver) · 5: 26+ or no sales, clearance or LP return (approver).

**Trouble thresholds:** stock-out risk 4+ urgent lines (LP) / 3+ (brand) or 30%+ of active SKUs; overstocked 50%+ of active SKUs over 8 weeks; aged stock $75K+ (LP) / $40K+ (brand) in buckets 4-5; dead stock 3+ SKUs; case packs 2+ SKUs; stockouts 3+ SKUs in 12 weeks. Severity = urgent x 3 + dead stock x 2 + case pack issues + aged value / $20K + share over 8 weeks x 10. Trouble = has a reason and ranks top 5 LPs or top 8 brands.
