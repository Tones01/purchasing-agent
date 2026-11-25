const tools = [
  ["get_planning_context", "Planning date, history window, lead time and metric definitions"],
  ["list_lps", "Suppliers with lead times, brands, active SKUs and open POs"],
  ["get_lp_stock_overview", "Reorder screening: sales speed, trend, stock and weeks on hand per SKU"],
  ["get_sku_detail", "26-week history with promo and stockout flags, promos, open PO lines"],
  ["find_similar_products", "Same brand and category comparables for new launches"],
  ["get_promo_lift", "Past promo lift and the lift to use for an upcoming promo"],
  ["list_upcoming_promos", "Promos starting after the planning date"],
  ["list_overstock", "SKUs over 8 weeks of stock, plus dead stock, for the aging agent"],
  ["list_open_purchase_orders", "Open POs and their lines"],
  ["search_products", "Find SKUs by name, brand, LP, category or lifecycle"],
];

export default function Home() {
  return (
    <main>
      <h1>Purchasing Agent MCP Server</h1>
      <p>
        Read-only tools for a team of AI agents that drafts weekly purchase orders for a fictional cannabis
        wholesale distributor. A person approves everything. All data is made up.
      </p>
      <p>
        Endpoint: <code>/api/mcp</code> (Streamable HTTP, key required)
      </p>
      <h2>Tools</h2>
      <ul>
        {tools.map(([name, desc]) => (
          <li key={name}>
            <code>{name}</code>: {desc}
          </li>
        ))}
      </ul>
    </main>
  );
}
