'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRole, submitKpiValue } from '../lib/founder';

// KPI value entry form on the per-KPI detail page. Visibility is gated by the
// input_kpi_data capability from GET /me (same map as POST /api/kpi-values).
// board_member and unauthenticated sessions never receive this form in the DOM.
function defaultPeriod() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
}

export default function KpiValueForm({ kpiKey, latestValue, latestPeriod, onSaved }) {
  const { capabilities, loading } = useRole();
  const [period, setPeriod] = useState(() =>
    latestPeriod ? String(latestPeriod).slice(0, 7) : defaultPeriod()
  );
  const [value, setValue] = useState(
    latestValue != null && latestValue !== '' ? String(latestValue) : ''
  );
  const [note, setNote] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const canInput =
    Array.isArray(capabilities) && capabilities.includes('input_kpi_data');
  if (loading || !canInput) return null;

  async function onSubmit(e) {
    e.preventDefault();
    setStatus(null);
    if (value === '' || Number.isNaN(Number(value))) {
      setStatus({ ok: false, msg: 'Enter a numeric value.' });
      return;
    }
    setBusy(true);
    try {
      await submitKpiValue({ key: kpiKey, period, value, note });
      setStatus({
        ok: true,
        msg: `Saved ${kpiKey} = ${value} for ${period}. Reload keeps this value.`
      });
      setNote('');
      if (onSaved) onSaved();
    } catch (err) {
      setStatus({
        ok: false,
        msg:
          err.status === 403
            ? 'You do not have permission to record KPI values.'
            : 'Could not save the value. Please try again.'
      });
    }
    setBusy(false);
  }

  return (
    <section
      className="panel"
      aria-labelledby="kpi-value-entry-heading"
      data-testid="kpi-value-write"
    >
      <h2 id="kpi-value-entry-heading">Update this KPI value</h2>
      <p className="kpi-card__note">
        Requires the <code>input_kpi_data</code> capability. Changes persist after
        reload and are recorded in the <Link href="/update">audit trail</Link>.
      </p>
      <form onSubmit={onSubmit} data-testid="value-entry-form">
        <input type="hidden" name="key" value={kpiKey} />
        <div className="field">
          <label htmlFor={`kpi-period-${kpiKey}`}>Period (month)</label>
          <input
            id={`kpi-period-${kpiKey}`}
            name="period"
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            required
            data-testid="kpi-value-period"
          />
        </div>
        <div className="field">
          <label htmlFor={`kpi-value-${kpiKey}`}>Value</label>
          <input
            id={`kpi-value-${kpiKey}`}
            name="value"
            type="number"
            step="any"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            data-testid="kpi-value-input"
          />
        </div>
        <div className="field">
          <label htmlFor={`kpi-note-${kpiKey}`}>Note (optional)</label>
          <input
            id={`kpi-note-${kpiKey}`}
            name="note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="kpi-value-note"
          />
        </div>
        {status ? (
          <p
            className={status.ok ? 'form-status form-status--ok' : 'auth__error'}
            role="status"
            data-testid="value-entry-status"
          >
            {status.msg}
          </p>
        ) : null}
        <button
          className="btn"
          type="submit"
          disabled={busy}
          data-testid="kpi-value-submit"
        >
          {busy ? 'Saving…' : 'Save value'}
        </button>
      </form>
    </section>
  );
}
