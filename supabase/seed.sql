-- seed.sql
-- The single, idempotent Boardroom seed script. Safe to run any number of
-- times: every row is keyed on a stable natural key (layers.position,
-- kpis.key) and upserted with ON CONFLICT ... DO UPDATE. Two consecutive runs
-- therefore produce identical final row counts (5 layers, 25 KPIs).
--
-- Run with:  psql "$DATABASE_URL" -f supabase/seed.sql
-- (or via the wrapper: supabase/seed.sh)

begin;

-- ---------------------------------------------------------------------------
-- 5 ordered layers: positions 1-3 are actively managed, 4-5 are not.
-- ---------------------------------------------------------------------------
with seed_layers(position, name, description, manage) as (
  values
    (1, 'Financial Health',       'Revenue, margin, and cash — the board''s primary financial dials.', true),
    (2, 'Order Operations',       'How efficiently orders flow from intake to delivery.',              true),
    (3, 'Sales & Growth',         'Pipeline, bookings, and customer expansion.',                       true),
    (4, 'Customer & Quality',     'Customer sentiment and quality outcomes (monitored).',              false),
    (5, 'People & Organization',  'Team health and organizational leverage (monitored).',              false)
)
insert into public.layers (position, name, description, manage)
select position, name, description, manage from seed_layers
on conflict (position) do update
  set name        = excluded.name,
      description = excluded.description,
      manage      = excluded.manage;

-- ---------------------------------------------------------------------------
-- 25 seed KPIs. layer_position joins to the layer seeded above.
-- Numeric thresholds are bare literals so the VALUES columns type as numeric;
-- NULL is allowed where a KPI uses target_min/target_max instead.
-- ---------------------------------------------------------------------------
with seed_kpis(
  key, name, definition, owner, cadence, layer_position,
  direction, unit,
  green_threshold, yellow_threshold, red_threshold,
  target_min, target_max, notes
) as (
  values
    -- Layer 1 — Financial Health
    ('revenue_plan_fy1', 'Revenue Plan FY1', 'Annual revenue plan for fiscal year 1.', 'CFO', 'annual', 1,
      'up_good', 'USD', 29000000, NULL, NULL, NULL, NULL, 'Annual revenue plan — $29M placeholder (TBD).'),
    ('revenue_plan_fy2', 'Revenue Plan FY2', 'Annual revenue plan for fiscal year 2.', 'CFO', 'annual', 1,
      'up_good', 'USD', 33000000, NULL, NULL, NULL, NULL, 'Annual revenue plan — $33M placeholder (TBD).'),
    ('revenue_plan_fy3', 'Revenue Plan FY3', 'Annual revenue plan for fiscal year 3.', 'CFO', 'annual', 1,
      'up_good', 'USD', 35000000, NULL, NULL, NULL, NULL, 'Annual revenue plan — $35M placeholder (TBD).'),
    ('gross_margin_pct', 'Gross Margin %', 'Gross profit as a percent of revenue.', 'CFO', 'monthly', 1,
      'up_good', '%', 38, 34, 30, NULL, NULL, 'Higher is better; watch below 34%.'),
    ('ebitda_margin_pct', 'EBITDA Margin %', 'EBITDA as a percent of revenue.', 'CFO', 'monthly', 1,
      'up_good', '%', 12, 8, 5, NULL, NULL, 'Operating profitability.'),
    ('cash_runway_months', 'Cash Runway (months)', 'Months of operating cash at current burn.', 'CFO', 'monthly', 1,
      'up_good', 'months', 9, 6, 3, NULL, NULL, 'Below 3 months is critical.'),

    -- Layer 2 — Order Operations
    ('bypass_count', 'Bypass Count', 'Number of orders that bypassed the standard process this period.', 'COO', 'weekly', 2,
      'down_good', 'count', 0, 2, 3, NULL, NULL, 'The single most important number on this scorecard. Green=0, Yellow=1-2, Red=3+.'),
    ('touches_per_order', 'Touches per Order', 'Average number of human touches to fulfil one order.', 'COO', 'weekly', 2,
      'down_good', 'touches', 6, NULL, NULL, 12, 15, 'Baseline 12-15 touches per order; green <= 6.'),
    ('on_time_delivery_pct', 'On-Time Delivery %', 'Percent of orders delivered by the promised date.', 'COO', 'weekly', 2,
      'up_good', '%', 97, 93, 90, NULL, NULL, 'Below 90% is red.'),
    ('order_error_rate', 'Order Error Rate %', 'Percent of orders with a fulfilment error.', 'COO', 'weekly', 2,
      'down_good', '%', 1, 3, 5, NULL, NULL, 'Lower is better.'),
    ('avg_order_cycle_days', 'Avg Order Cycle (days)', 'Average days from order intake to delivery.', 'COO', 'weekly', 2,
      'down_good', 'days', 5, 8, 12, NULL, NULL, 'Speed of fulfilment.'),
    ('supplier_defect_rate', 'Supplier Defect Rate %', 'Percent of supplier shipments with defects.', 'COO', 'monthly', 2,
      'down_good', '%', 1, 2, 4, NULL, NULL, 'Inbound quality.'),

    -- Layer 3 — Sales & Growth
    ('new_bookings', 'New Bookings', 'New booked revenue this month.', 'CRO', 'monthly', 3,
      'up_good', 'USD', 2500000, 1800000, 1200000, NULL, NULL, 'Monthly booked revenue.'),
    ('pipeline_coverage_ratio', 'Pipeline Coverage Ratio', 'Open pipeline divided by the period quota.', 'CRO', 'monthly', 3,
      'up_good', 'x', 3, 2, 1.5, NULL, NULL, '3x coverage is healthy.'),
    ('win_rate_pct', 'Win Rate %', 'Percent of qualified opportunities won.', 'CRO', 'monthly', 3,
      'up_good', '%', 30, 22, 15, NULL, NULL, 'Sales effectiveness.'),
    ('repeat_customer_rate', 'Repeat Customer Rate %', 'Percent of revenue from returning customers.', 'CRO', 'monthly', 3,
      'up_good', '%', 60, 45, 35, NULL, NULL, 'Loyalty and retention.'),
    ('avg_order_value', 'Average Order Value', 'Average revenue per order.', 'CRO', 'monthly', 3,
      'up_good', 'USD', 4000, 3000, 2000, NULL, NULL, 'Basket size.'),

    -- Layer 4 — Customer & Quality (monitored)
    ('nps', 'Net Promoter Score', 'Customer net promoter score.', 'VP Customer', 'quarterly', 4,
      'up_good', 'score', 50, 30, 10, NULL, NULL, 'Customer advocacy.'),
    ('customer_churn_rate', 'Customer Churn Rate %', 'Percent of customers lost in the period.', 'VP Customer', 'quarterly', 4,
      'down_good', '%', 5, 10, 15, NULL, NULL, 'Lower is better.'),
    ('quote_turnaround_hours', 'Quote Turnaround (hours)', 'Average hours to return a customer quote.', 'VP Customer', 'weekly', 4,
      'down_good', 'hours', 24, 48, 72, NULL, NULL, 'Responsiveness.'),
    ('reorder_rate', 'Reorder Rate %', 'Percent of customers who reorder within 90 days.', 'VP Customer', 'monthly', 4,
      'up_good', '%', 40, 30, 20, NULL, NULL, 'Stickiness.'),

    -- Layer 5 — People & Organization (monitored)
    ('employee_enps', 'Employee eNPS', 'Employee net promoter score.', 'VP People', 'quarterly', 5,
      'up_good', 'score', 30, 10, 0, NULL, NULL, 'Team sentiment.'),
    ('voluntary_turnover_rate', 'Voluntary Turnover Rate %', 'Annualized voluntary employee turnover.', 'VP People', 'quarterly', 5,
      'down_good', '%', 8, 14, 20, NULL, NULL, 'Retention risk.'),
    ('revenue_per_employee', 'Revenue per Employee', 'Trailing revenue divided by headcount.', 'VP People', 'quarterly', 5,
      'up_good', 'USD', 300000, 250000, 200000, NULL, NULL, 'Organizational leverage.'),
    ('training_hours_per_fte', 'Training Hours per FTE', 'Average training hours per full-time employee.', 'VP People', 'quarterly', 5,
      'up_good', 'hours', 40, 20, 10, NULL, NULL, 'Investment in people.')
)
insert into public.kpis (
  key, name, definition, owner, cadence, layer_id,
  direction, unit, green_threshold, yellow_threshold, red_threshold,
  target_min, target_max, notes
)
select
  k.key, k.name, k.definition, k.owner, k.cadence, l.id,
  k.direction, k.unit, k.green_threshold, k.yellow_threshold, k.red_threshold,
  k.target_min, k.target_max, k.notes
from seed_kpis k
join public.layers l on l.position = k.layer_position
on conflict (key) do update
  set name             = excluded.name,
      definition       = excluded.definition,
      owner            = excluded.owner,
      cadence          = excluded.cadence,
      layer_id         = excluded.layer_id,
      direction        = excluded.direction,
      unit             = excluded.unit,
      green_threshold  = excluded.green_threshold,
      yellow_threshold = excluded.yellow_threshold,
      red_threshold    = excluded.red_threshold,
      target_min       = excluded.target_min,
      target_max       = excluded.target_max,
      notes            = excluded.notes;

commit;

-- Final row counts (for idempotency evidence).
select 'layers' as table, count(*) as rows from public.layers
union all
select 'kpis'  as table, count(*) as rows from public.kpis
order by 1;
