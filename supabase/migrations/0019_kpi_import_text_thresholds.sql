-- The scorecard contract uses human-readable RAG labels (for example
-- "1–2" and "3+ or any override ..."), not only numeric bounds.  Keep the
-- durable import/export source capable of representing that exact UI text.
alter table public.kpis
  alter column green_threshold type text using green_threshold::text,
  alter column yellow_threshold type text using yellow_threshold::text,
  alter column red_threshold type text using red_threshold::text;
