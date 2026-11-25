-- Least-privilege login for the MCP server: SELECT only, read-only transactions,
-- statement timeout, connection cap, and no access to the eval answer key.
-- Set the real password out of band; never commit it.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'mcp_reader') then
    create role mcp_reader login noinherit password '<set-a-strong-password>';
  end if;
end $$;
alter role mcp_reader set default_transaction_read_only = on;
alter role mcp_reader set statement_timeout = '15s';
alter role mcp_reader connection limit 25;

revoke all on schema eval_internal from mcp_reader;
grant usage on schema public to mcp_reader;
grant select on
  public.lps, public.brands, public.products, public.stores, public.weekly_sales, public.stockout_weeks,
  public.promos, public.inventory_on_hand, public.purchase_orders, public.po_lines, public.planning_config,
  public.v_week_flags, public.v_sku_metrics, public.v_promo_lift
to mcp_reader;

create policy mcp_reader_select on public.lps for select to mcp_reader using (true);
create policy mcp_reader_select on public.brands for select to mcp_reader using (true);
create policy mcp_reader_select on public.products for select to mcp_reader using (true);
create policy mcp_reader_select on public.stores for select to mcp_reader using (true);
create policy mcp_reader_select on public.weekly_sales for select to mcp_reader using (true);
create policy mcp_reader_select on public.stockout_weeks for select to mcp_reader using (true);
create policy mcp_reader_select on public.promos for select to mcp_reader using (true);
create policy mcp_reader_select on public.inventory_on_hand for select to mcp_reader using (true);
create policy mcp_reader_select on public.purchase_orders for select to mcp_reader using (true);
create policy mcp_reader_select on public.po_lines for select to mcp_reader using (true);
create policy mcp_reader_select on public.planning_config for select to mcp_reader using (true);

revoke all on public.v_week_flags, public.v_sku_metrics, public.v_promo_lift from anon, authenticated;
