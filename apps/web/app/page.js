'use client';

import AuthGuard from '../components/AuthGuard';

// RAG-scored preview of the board scorecard. Static placeholder data — the live
// KPI feed arrives in a later mission — but every color already flows through
// the theme tokens (--rag-*, --band-*).
const METRICS = [
  { name: 'Revenue vs. Plan', band: 'manage', rag: 'green' },
  { name: 'Gross Margin', band: 'manage', rag: 'yellow' },
  { name: 'Cash Runway', band: 'monitor', rag: 'green' },
  { name: 'Order Backlog', band: 'monitor', rag: 'red' },
  { name: 'Supplier On-Time', band: 'monitor', rag: 'yellow' },
  { name: 'NPS', band: 'monitor', rag: 'none' }
];

export default function HomePage() {
  return (
    <AuthGuard>
      <p className="eyebrow">Board scorecard</p>
      <h1>The Image Group at a glance</h1>
      <p className="lede">
        A single, calm surface for running the company from the top down —
        red/amber/green health across the metrics the board manages and the ones
        it monitors.
      </p>

      <section className="scorecard" aria-label="Scorecard metrics">
        {METRICS.map((m) => (
          <article className="metric" key={m.name}>
            <span className={`metric__band metric__band--${m.band}`}>
              {m.band}
            </span>
            <span className="metric__name">{m.name}</span>
            <span className="metric__status">
              <span className={`rag-dot rag-dot--${m.rag}`} aria-hidden="true" />
              {m.rag === 'none' ? 'No reading' : m.rag}
            </span>
          </article>
        ))}
      </section>
    </AuthGuard>
  );
}
