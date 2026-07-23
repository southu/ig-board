-- Full replacement seed for the board-approved scorecard.
begin;

-- This mission is a wipe-and-rebuild of scorecard content. Dependent values
-- and comments on retired KPIs follow their existing foreign-key cascades;
-- the history/comments tables, routes, and policies themselves are preserved.
delete from public.watch_items;
delete from public.kpis;
delete from public.layers;

insert into public.layers (position, name, description, manage) values
  (1, 'LEADERSHIP ALIGNMENT', 'Are the two founders operating as one aligned leadership team with clear lanes?', true),
  (2, 'MANAGEMENT SYSTEMS', 'Does the environment let capable people succeed?', true),
  (3, 'CAPABILITIES & EXECUTION', 'What can the machine do without a founder touching it?', true),
  (4, 'REVENUE GROWTH', 'Agreed targets — with quality guards so the number can''t be gamed.', false),
  (5, 'ENTERPRISE VALUE', 'The scoreboard, not a dial. Nobody enters this manually except one annual figure.', false);

with seed_kpis(
  code, key, name, definition, owner, cadence, layer_position, type,
  direction, unit, baseline, baseline_source,
  green_text, yellow_text, red_text, definition_note, manual_entry, metadata
) as (
  values
    ('1.1', 'decision_rights_map_completion', 'Decision-Rights Map Completion',
      'Decision-Rights Map Completion; board verifies via document uploaded to this app.',
      'Zack & Jon jointly', 'monthly until 100% then quarterly reconfirm', 1, 'permanent_kpi',
      'up_good', '%', '0% — no map exists', 'no map exists',
      '100% signed', 'drafted unsigned', 'no map', null, true,
      '{"verification":"document uploaded to this app"}'::jsonb),
    ('1.2', 'bypass_count', 'Bypass Count',
      'Bypasses reported by Zack & Jon in a running log, with the board cross-checking each meeting.',
      'self-reported by Zack & Jon in a running log, board cross-checks each meeting', 'monthly', 1, 'permanent_kpi',
      'down_good', 'count', 'unknown — never counted', 'never counted',
      '0', '1–2', '3+ or any override without written rationale',
      'The single most important number on this scorecard.', true, '{}'::jsonb),
    ('1.3', 'joint_priorities_document_current', 'Joint Priorities Document Current',
      'Whether the joint priorities document is current and signed by both founders.',
      'Jon', 'quarterly', 1, 'permanent_kpi',
      'up_good', 'status', null, null,
      'current and signed by both', '>1 quarter old', 'missing or signed by only one founder', null, true, '{}'::jsonb),
    ('2.1', 'role_clarity_score', 'Role Clarity Score',
      'Role clarity measured by an external survey tool, with results delivered to board and founders simultaneously, never administered or first-read by management.',
      'External survey tool — results delivered to board and founders simultaneously',
      'quarterly', 2, 'permanent_kpi', 'up_good', '%', 'never measured', 'never measured',
      '≥80%', '65–79%', '<65%', null, true, '{}'::jsonb),
    ('2.2', 'survey_response_rate', 'Survey Response Rate',
      'Participation rate in the quarterly role-clarity survey.',
      'external survey tool', 'quarterly', 2, 'permanent_kpi',
      'up_good', '%', '~26 responses — low turnout was dismissed',
      'The last company survey received ~26 responses and low turnout was dismissed.',
      '≥85%', '70–84%', '<70%',
      'The last company survey received ~26 responses and low turnout was dismissed. Participation is itself a trust measurement.',
      true, '{}'::jsonb),
    ('2.3', 'success_criteria_coverage', 'Success-Criteria Coverage',
      'Coverage of documented success criteria, with the board sampling two documents at random per quarter.',
      'department heads report, Jaime compiles', 'quarterly', 2, 'permanent_kpi',
      'up_good', '%', '~0%', '~0%',
      '100% of managers by Q4 2026, 100% of all roles by mid-2027', null, null, null, true,
      '{"green_trajectory":"100% of managers by Q4 2026, 100% of all roles by mid-2027","verification":"sample two documents at random per quarter"}'::jsonb),
    ('3.1', 'time_to_first_revenue', 'Time to First Revenue',
      'Time from CRM win date to NetSuite invoice date.',
      'Jaime, NetSuite invoice dates vs CRM win dates', 'quarterly', 3, 'permanent_kpi',
      'down_good', 'months', '18+ months — Rinnai/Fortune Brands', 'Rinnai/Fortune Brands',
      '≤6 months', '7–12', '>12', null, true, '{}'::jsonb),
    ('3.2', 'founder_intervention_count', 'Founder Intervention Count',
      'Founder interventions self-reported by Zack in a log, with the board verifying by asking the management team.',
      'Zack', 'quarterly', 3, 'permanent_kpi',
      'down_good', 'count', '3+ per half-year — DSSI/ESP Plus/Gong examples', 'DSSI/ESP Plus/Gong examples',
      '0', '1', '2+', 'Each intervention is counted as evidence about the system, not credited as a save.',
      true, '{"verification":"board cross-checks by asking the management team"}'::jsonb),
    ('3.3', 'customer_touches_per_order', 'Customer Touches per Order',
      'Customer touches required per order.',
      'Enablement/ops owner once hired; Allison until then', 'quarterly', 3, 'permanent_kpi',
      'down_good', 'touches',
      '12–15 touches per management''s own June 2026 process documentation across ~12,000 orders/year',
      'management''s own June 2026 process documentation across ~12,000 orders/year',
      '≤6 by mid-2027', '7–9', '≥10', null, true, '{}'::jsonb),
    ('4.1', 'revenue_vs_plan', 'Revenue vs. Plan',
      'YTD revenue vs seasonalized plan.', 'Jaime', 'monthly, YTD vs seasonalized plan', 4, 'permanent_kpi',
      'up_good', '%', null, null, '≥97%', '90–96%', '<90%', null, true,
      '{"plan":"2026 $29M, 2027 $33M, 2028 $35M"}'::jsonb),
    ('4.2', 'core_net_ordinary_income', 'Core Net Ordinary Income',
      'Core net ordinary income; excludes vendor rebates and Applied Production.',
      'Jaime', 'monthly', 4, 'permanent_kpi', 'up_good', 'USD',
      'Jan–May core NOI –$70K 2024, $258K 2025, $354K 2026',
      'Jan–May core NOI –$70K 2024, $258K 2025, $354K 2026',
      '2027 full-year ≥$1M', null, null, 'Growth bought with margin doesn''t count.', true,
      '{"exclusions":"vendor rebates and Applied Production"}'::jsonb),
    ('4.3', 'customer_concentration', 'Customer Concentration',
      'Largest account % of T12M revenue with top-5 % also displayed.',
      'Jaime', 'quarterly', 4, 'permanent_kpi', 'down_good', '%', null, null,
      '≤20%', '21–30%', '>30%', 'Richmond became a single-account business once already.', true, '{}'::jsonb),
    ('5.1', 'adjusted_ebitda_ttm', 'Adjusted EBITDA (TTM)',
      'Adjusted EBITDA (TTM) per written board-agreed definition.',
      'Jaime', 'quarterly', 5, 'permanent_kpi', 'up_good', 'USD', null, null,
      null, null, null, null, true, '{}'::jsonb),
    ('5.2', 'exit_readiness_score', 'Exit-Readiness Score',
      'Computed exit-readiness score; the calculation itself ships in a later step.',
      'computed', 'computed', 5, 'computed', 'up_good', 'score', null, null,
      null, null, null, 'the calculation itself ships in a later step', false, '{}'::jsonb)
)
insert into public.kpis (
  code, key, name, definition, owner, cadence, layer_id, type,
  direction, unit, baseline, baseline_source,
  green_text, yellow_text, red_text, definition_note, notes, manual_entry, metadata
)
select
  k.code, k.key, k.name, k.definition, k.owner, k.cadence, l.id, k.type,
  k.direction, k.unit, k.baseline, k.baseline_source,
  k.green_text, k.yellow_text, k.red_text, k.definition_note, k.definition_note, k.manual_entry, k.metadata
from seed_kpis k
join public.layers l on l.position = k.layer_position;

insert into public.watch_items (
  key, name, type, layer_id, definition, green_text, review_text, review_at, disposition
)
select
  'six_month_rule_pilot_hire',
  'Six-Month Rule — Pilot Hire',
  'special_watch_item',
  id,
  'founder interventions inside the pilot hire''s mapped lane',
  '0',
  'reviewed at the January 2027 board meeting then retired or renewed',
  'January 2027 board meeting',
  'retired or renewed'
from public.layers where position = 2;

commit;

select 'kpis' as table, count(*) as rows from public.kpis
union all select 'layers', count(*) from public.layers
union all select 'watch_items', count(*) from public.watch_items
order by 1;
