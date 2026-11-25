# Rules the engine applies (spec v1.2)

Use these to explain any line. Quote the line's own numbers; never recompute them.

1. **Baseline sales velocity:** average weekly units over the last 12 weeks (or since launch). Leaves out promo weeks, the week after each promo, stockout weeks and flow-through units. Under 3 weeks of sales counts as a new launch.
2. **Weeks of stock (WSOH):** (on hand + all open POs) / baseline velocity, measured today (min/max method). New POs are planned as landing at the end of week 2.
3. **Reorder trigger:** under 6 weeks, or under 6 weeks plus the extra units an upcoming promo needs. Over 8 weeks with no promo goes to aging, never reorder.
   **Urgent:** stock left when a new PO could land (on hand + POs arriving within 2 weeks - 2 weeks of sales) is under 2 weeks.
4. **Target:** top seller (top 20% by 12-week revenue) 8 weeks; trending up (last 4 weeks over 10% above baseline) 8; slowing (over 10% below) 6; flat 7. Order = target x velocity + promo extra - (on hand + open POs).
5. **Rounding:** whole case packs. Round up unless that passes 8 weeks (plus promo weeks), then round down unless that drops under 6. If neither works, round up and flag `case_pack_overshoot`.
6. **Launches:** always listed. Stock to 6 weeks using the average velocity of established SKUs with the same brand and category. None: decision `review`, flag `no_similar_products`.
7. **Promos:** extra units = (lift - 1) x velocity x promo weeks. Lift from the SKU's past promos, then the brand average, then 1.5x. Lift = promo-week units / the 4 normal weeks before the promo. Every promo line is flagged.
   **Limited editions:** never reordered. Low ones flagged `limited_edition_low`; overstocked ones get an aging action.
8. **Flow-through:** bought for a specific retailer order and shipped straight out. Never in velocity, never triggers a reorder.
9. **Approval:** no spend limit; one approver signs off everything.
10. **Aging buckets (WSOH over 8):** 1: 8 to 10 watch (purchasing) · 2: 10 to 13 feature in catalogue and email (marketing) · 3: 13 to 17 ask LP for supplier-funded promo (sales) · 4: 17 to 26 markdown (purchasing + approver) · 5: 26+ or no sales, clearance or LP return (approver). A booked promo shows "promo booked".

## Trouble thresholds (get_partner_health)

A row gets a trouble reason when:
- **Stock-out risk:** 4+ urgent lines (LP) or 3+ (brand), or 30%+ of active SKUs urgent
- **Overstocked:** 50%+ of active SKUs over 8 weeks
- **Aged stock:** $75K+ (LP) or $40K+ (brand) in buckets 4-5
- **Dead stock:** 3+ SKUs with stock and no sales
- **Case packs:** 2+ SKUs where the case pack forces overstock
- **Stockouts:** 3+ SKUs that ran out in the last 12 weeks

Severity score = urgent x 3 + dead stock x 2 + case pack issues + aged value / $20K + share of active SKUs over 8 weeks x 10. **is_trouble** = has a reason and ranks in the top 5 LPs or top 8 brands.
