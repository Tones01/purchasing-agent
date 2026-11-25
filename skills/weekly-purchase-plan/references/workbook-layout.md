# Workbook layout

File: `Purchase_Plan_<planning date>.xlsx`. Arial 10 throughout, header rows bold with a light grey fill, freeze the header row, autofilter on every data tab, column widths sized to content (max 60 for reason/notes columns, with wrap).

Tabs in this order. Exact names.

## 1. Summary

- A1: `Purchase Plan: week of <planning date>` (bold, 14pt). A2: `Draft for approval. Nothing has been sent to LPs.`
- **Key numbers** block (label in column A, value in column B). Values are formulas pointing at the PO Lines tab, not typed numbers:
  - PO lines: `=COUNTA('PO Lines'!B:B)-1`
  - LPs with a PO: count of rows in the POs by LP table below (`=COUNTA(...)`)
  - Units: `=SUM('PO Lines'!G:G)`
  - Cost: `=SUM('PO Lines'!K:K)` (format `$#,##0`)
  - Urgent lines: `=COUNTIF('PO Lines'!N:N,TRUE)`
  - Lines needing review: `=COUNTA(Review!B:B)-1`
- **Executive summary:** the summary from SKILL.md step 5, one item per row in column A (wrap text).
- **Trouble LPs** table: Rank, LP, Severity score, Trouble reasons (joined with "; "), PO cost, Urgent lines, Aged value (b4-5).
- **Trouble brands** table: Rank, Brand, LP, Severity score, Trouble reasons, Urgent lines, Aged value (b4-5).
- **POs by LP** table: LP, Lines, Units, Cost, Urgent. Lines/Units/Cost/Urgent are `COUNTIF`/`SUMIF` formulas against PO Lines, keyed on the LP name in column A. Sort by cost, largest first.

## 2. PO Lines

All rows from `export_purchase_plan` `po_lines`, in its order (grouped by LP, urgent first). Columns A to P exactly as exported:
`lp_name, sku, name, brand, category, size, order_qty, case_pack, cases, unit_cost, line_cost, wsoh_now, wsoh_after_order, urgent, review_flags, reason`

Then two approver columns with a yellow fill:
- Q `Approve (Y/N)`: blank
- R `Approver notes`: blank

Formats: `unit_cost` and `line_cost` as `$#,##0.00`, weeks as `0.0`. Rows where `urgent` is TRUE get a light red fill.

## 3. Review

All rows from `export_purchase_plan` `review`, plus three columns after the export columns:
- `Recommendation`: from SKILL.md step 2, 12 words max
- `Action owner`: purchasing, sales, marketing or approver
- `Approver decision`: blank, yellow fill

Sort: urgent first, then no_similar_products, then dead stock (no_sales_with_stock, bucket_5), then the rest by LP.

## 4. Aging

- Top: one handoff line per owner (SKILL.md step 3), bold label in column A, text in column B.
- Leave one blank row, then all rows from `export_purchase_plan` `aging` with headers. Format `aged_value` as `$#,##0`.

## 5. Notes

Short legend:
- What each tab is for
- Yellow cells are for the approver to fill in
- Weeks of stock = (on hand + open POs) / baseline weekly sales
- Targets: top seller or trending up 8 weeks, flat 7, slowing 6, launches 6
- Trouble thresholds come from the engine (see `get_partner_health`)
- Source: Purchasing Agent MCP server, planning date <date>. All figures from the rules engine.

## Checks before handing over

- Recalculate. Zero formula errors.
- Summary cost equals the sum of `line_cost` in the po_lines export.
- Row counts match the exports: PO Lines = po_lines rows, Review = review rows, Aging = aging rows.
