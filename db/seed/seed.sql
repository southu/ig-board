-- seed.sql
-- ONE idempotent seed for Boardroom reference data.
--
-- Running it any number of times converges to the SAME rows (upsert on natural
-- keys: layers.position and kpis.key), so final row counts are identical on
-- every run. It seeds ONLY reference data: exactly 5 ordered layers and the
-- ~25 scorecard KPIs. It does not touch users / measurements / audit data.

begin;

-- ---------------------------------------------------------------------------
-- Layers: exactly 5, ordered. Positions 1-3 are actively managed (manage=true);
-- 4-5 are monitored only (manage=false).
-- ---------------------------------------------------------------------------
insert into public.layers (position, name, slug, manage, description) values
  (1, 'Board & Vision',      'board-vision', true,
      'Top-of-house scorecard the board owns: plan, profitability, cash, clients.'),
  (2, 'Executive Scorecard', 'executive',    true,
      'Company-wide execution metrics owned by the executive team.'),
  (3, 'Operations',          'operations',   true,
      'Order-to-delivery operating metrics; the engine room of the business.'),
  (4, 'Team & Department',   'team',         false,
      'Departmental performance the board monitors but does not manage directly.'),
  (5, 'Individual & Frontline', 'individual', false,
      'Frontline / individual activity metrics rolled up for visibility.')
on conflict (position) do update set
  name        = excluded.name,
  slug        = excluded.slug,
  manage      = excluded.manage,
  description = excluded.description;

-- ---------------------------------------------------------------------------
-- KPIs: ~25 across the 5 layers. layer resolved by position. thresholds carry
-- the green/yellow/red bands (numeric or human ranges). is_placeholder marks
-- KPIs whose targets are still TBD.
-- ---------------------------------------------------------------------------
insert into public.kpis
  (layer_id, key, name, definition, owner, cadence, direction, unit,
   baseline, thresholds, is_placeholder, sort_order)
select l.id, v.key, v.name, v.definition, v.owner, v.cadence, v.direction,
       v.unit, v.baseline, v.thresholds::jsonb, v.is_placeholder, v.sort_order
from (values
  -- Layer 1 — Board & Vision -------------------------------------------------
  (1, 'revenue_plan', 'Revenue Plan',
      'Annual revenue measured against the board-approved plan ($29M / $33M / $35M across the three-year plan).',
      'CFO', 'annual', 'up_good', 'USD', NULL,
      '{"green": 35000000, "yellow": 33000000, "red": 29000000, "plan": [29000000, 33000000, 35000000]}',
      false, 1),
  (1, 'ebitda_margin', 'EBITDA Margin',
      'Earnings before interest, tax, depreciation and amortization as a percent of revenue.',
      'CFO', 'monthly', 'up_good', '%', NULL,
      '{"green": 12, "yellow": 8, "red": 5}', false, 2),
  (1, 'cash_runway_months', 'Cash Runway',
      'Months of operating runway at the current burn rate.',
      'CFO', 'monthly', 'up_good', 'months', NULL,
      '{"green": 6, "yellow": 3, "red": 1}', false, 3),
  (1, 'client_nps', 'Client NPS',
      'Net Promoter Score across active client accounts. Target bands TBD pending baseline survey.',
      'VP Client Experience', 'quarterly', 'up_good', 'score', NULL,
      '{"green": "TBD", "yellow": "TBD", "red": "TBD"}', true, 4),

  -- Layer 2 — Executive Scorecard -------------------------------------------
  (2, 'new_bookings', 'New Bookings',
      'Value of newly booked orders in the period.',
      'VP Sales', 'monthly', 'up_good', 'USD', NULL,
      '{"green": 3000000, "yellow": 2200000, "red": 1500000}', false, 5),
  (2, 'gross_margin', 'Gross Margin',
      'Gross profit as a percent of revenue.',
      'CFO', 'monthly', 'up_good', '%', NULL,
      '{"green": 35, "yellow": 30, "red": 25}', false, 6),
  (2, 'revenue_per_employee', 'Revenue per Employee',
      'Trailing revenue divided by full-time headcount.',
      'COO', 'quarterly', 'up_good', 'USD', NULL,
      '{"green": 250000, "yellow": 200000, "red": 150000}', false, 7),
  (2, 'pipeline_coverage', 'Pipeline Coverage',
      'Open pipeline value as a multiple of the period quota.',
      'VP Sales', 'monthly', 'up_good', 'x', NULL,
      '{"green": 3, "yellow": 2, "red": 1}', false, 8),
  (2, 'dso_days', 'Days Sales Outstanding',
      'Average number of days to collect receivables.',
      'Controller', 'monthly', 'down_good', 'days', NULL,
      '{"green": 30, "yellow": 45, "red": 60}', false, 9),

  -- Layer 3 — Operations -----------------------------------------------------
  (3, 'bypass_count', 'Bypass Count',
      'the single most important number on this scorecard',
      'COO', 'weekly', 'down_good', 'count', NULL,
      '{"green": "0", "yellow": "1-2", "red": "3+", "green_max": 0, "yellow_min": 1, "yellow_max": 2, "red_min": 3}',
      false, 10),
  (3, 'touches_per_order', 'Touches per Order',
      'Number of human touches required to move an order from quote to fulfillment. Fewer is better.',
      'COO', 'weekly', 'down_good', 'touches', '12-15',
      '{"green": "<=6", "green_max": 6, "baseline": "12-15", "baseline_min": 12, "baseline_max": 15}',
      false, 11),
  (3, 'on_time_delivery', 'On-Time Delivery',
      'Percent of orders delivered on or before the promised date.',
      'VP Operations', 'weekly', 'up_good', '%', NULL,
      '{"green": 98, "yellow": 95, "red": 90}', false, 12),
  (3, 'order_accuracy', 'Order Accuracy',
      'Percent of orders shipped with no error (SKU, quantity, decoration).',
      'VP Operations', 'weekly', 'up_good', '%', NULL,
      '{"green": 99, "yellow": 97, "red": 95}', false, 13),
  (3, 'supplier_defect_rate', 'Supplier Defect Rate',
      'Percent of received supplier goods rejected for defects.',
      'Procurement Lead', 'monthly', 'down_good', '%', NULL,
      '{"green": 1, "yellow": 3, "red": 5}', false, 14),
  (3, 'quote_turnaround_hours', 'Quote Turnaround',
      'Hours from quote request to quote delivered to the client.',
      'Sales Ops', 'weekly', 'down_good', 'hours', NULL,
      '{"green": 4, "yellow": 8, "red": 24}', false, 15),
  (3, 'production_cycle_days', 'Production Cycle Time',
      'Days from art approval to shipment.',
      'VP Operations', 'weekly', 'down_good', 'days', NULL,
      '{"green": 5, "yellow": 8, "red": 12}', false, 16),

  -- Layer 4 — Team & Department ---------------------------------------------
  (4, 'rep_quota_attainment', 'Rep Quota Attainment',
      'Percent of quota attained by the sales team in the period.',
      'Sales Manager', 'monthly', 'up_good', '%', NULL,
      '{"green": 100, "yellow": 80, "red": 60}', false, 17),
  (4, 'avg_order_value', 'Average Order Value',
      'Average booked value per order.',
      'Sales Manager', 'monthly', 'up_good', 'USD', NULL,
      '{"green": 5000, "yellow": 3000, "red": 1500}', false, 18),
  (4, 'reorder_rate', 'Reorder Rate',
      'Percent of clients placing a repeat order within the period.',
      'Account Management', 'quarterly', 'up_good', '%', NULL,
      '{"green": 40, "yellow": 25, "red": 15}', false, 19),
  (4, 'sample_conversion', 'Sample-to-Order Conversion',
      'Percent of samples sent that convert to a booked order.',
      'Sales Manager', 'monthly', 'up_good', '%', NULL,
      '{"green": 35, "yellow": 20, "red": 10}', false, 20),
  (4, 'csat', 'Customer Satisfaction (CSAT)',
      'Post-order customer satisfaction score. Target bands TBD pending survey rollout.',
      'VP Client Experience', 'monthly', 'up_good', 'score', NULL,
      '{"green": "TBD", "yellow": "TBD", "red": "TBD"}', true, 21),
  (4, 'rework_rate', 'Rework Rate',
      'Percent of orders requiring rework after production.',
      'Production Lead', 'weekly', 'down_good', '%', NULL,
      '{"green": 2, "yellow": 5, "red": 8}', false, 22),

  -- Layer 5 — Individual & Frontline ----------------------------------------
  (5, 'outreach_touches_per_day', 'Outreach Touches per Day',
      'Outbound sales touches logged per rep per day.',
      'Sales Rep', 'daily', 'up_good', 'touches', NULL,
      '{"green": 40, "yellow": 25, "red": 15}', false, 23),
  (5, 'proofs_first_pass', 'Proofs Approved First Pass',
      'Percent of art proofs approved by the client on the first submission.',
      'Art Team', 'weekly', 'up_good', '%', NULL,
      '{"green": 90, "yellow": 75, "red": 60}', false, 24),
  (5, 'billable_utilization', 'Billable Utilization',
      'Percent of capacity spent on billable work. Too low is idle, too high risks burnout.',
      'Team Lead', 'weekly', 'target_band', '%', NULL,
      '{"target_min": 70, "target_max": 90, "green": "70-90", "yellow": "60-70 or 90-95", "red": "<60 or >95"}',
      false, 25)
) as v(layer_pos, key, name, definition, owner, cadence, direction, unit,
       baseline, thresholds, is_placeholder, sort_order)
join public.layers l on l.position = v.layer_pos
on conflict (key) do update set
  layer_id       = excluded.layer_id,
  name           = excluded.name,
  definition     = excluded.definition,
  owner          = excluded.owner,
  cadence        = excluded.cadence,
  direction      = excluded.direction,
  unit           = excluded.unit,
  baseline       = excluded.baseline,
  thresholds     = excluded.thresholds,
  is_placeholder = excluded.is_placeholder,
  sort_order     = excluded.sort_order;

commit;
