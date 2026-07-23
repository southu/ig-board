'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import AuthGuard from '../../components/AuthGuard';
import { KPIS } from '../../lib/catalog';
import {
  useRole,
  useDefinitions,
  useAudit,
  submitKpiValue,
  submitDefinition
} from '../../lib/founder';

// The founder KPI update page. AuthGuard redirects unauthenticated visitors to
// /login (acceptance criterion 2). The founder controls — value entry,
// definition editing — render ONLY when GET /me resolves role 'founder'; a board
// session sees a read-only notice with no Update form or button anywhere in the
// DOM (criterion 5). Every value change and definition edit is written through
// the founder-only API, which records the audit trail shown below (criterion 7).
export default function UpdatePage() {
  return (
    <AuthGuard>
      <UpdateContent />
    </AuthGuard>
  );
}

function UpdateContent() {
  const { role, loading } = useRole();

  if (loading) {
    return (
      <div className="route-guard" aria-busy="true">
        Loading…
      </div>
    );
  }

  if (role !== 'founder') {
    // Board (or any non-founder): strictly read-only. No entry controls exist in
    // the DOM at all — the values themselves live on the read-only pyramid.
    return (
      <>
        <p className="eyebrow">Updates</p>
        <h1>KPI updates</h1>
        <p className="lede" data-testid="readonly-notice">
          Your access is read-only. KPI values and definitions are maintained by
          the founder. Browse the current scorecard on the{' '}
          <Link href="/">pyramid</Link>.
        </p>
      </>
    );
  }

  return <FounderConsole />;
}

function FounderConsole() {
  // Shared revision so a successful value or definition write reloads the audit
  // trail without a full page refresh — the founder sees who/when/old/new land
  // immediately after save.
  const [revision, setRevision] = useState(0);
  const bump = () => setRevision((n) => n + 1);
  return (
    <>
      <p className="eyebrow">Founder · updates</p>
      <h1>KPI updates &amp; definitions</h1>
      <p className="lede">
        Enter a KPI reading for a month, or revise a KPI&rsquo;s definition and
        thresholds. Every change is recorded in the audit trail below — who,
        when, and the old and new value.
      </p>
      <ValueEntryForm onSaved={bump} />
      <DefinitionEditForm onSaved={bump} />
      <AuditTrail revision={revision} />
    </>
  );
}

// A stable current month (YYYY-MM) default for the period field.
function defaultPeriod() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
}

function ValueEntryForm({ onSaved }) {
  const [key, setKey] = useState(KPIS[0].key);
  const [period, setPeriod] = useState(defaultPeriod());
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState(null); // { ok, msg }
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setStatus(null);
    if (value === '' || Number.isNaN(Number(value))) {
      setStatus({ ok: false, msg: 'Enter a numeric value.' });
      return;
    }
    setBusy(true);
    try {
      await submitKpiValue({ key, period, value, note });
      setStatus({ ok: true, msg: `Saved ${key} for ${period}.` });
      setValue('');
      setNote('');
      if (onSaved) onSaved();
    } catch (err) {
      setStatus({
        ok: false,
        msg:
          err.status === 403
            ? 'Only the founder can record values.'
            : 'Could not save the value. Please try again.'
      });
    }
    setBusy(false);
  }

  return (
    <section className="panel" aria-labelledby="value-entry-heading">
      <h2 id="value-entry-heading">Record a KPI value</h2>
      <form onSubmit={onSubmit} data-testid="value-entry-form">
        <div className="field">
          <label htmlFor="kpi-key">KPI</label>
          <select
            id="kpi-key"
            name="key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          >
            {KPIS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="kpi-period">Period (month)</label>
          <input
            id="kpi-period"
            name="period"
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="kpi-value">Value</label>
          <input
            id="kpi-value"
            name="value"
            type="number"
            step="any"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="kpi-note">Note (optional)</label>
          <input
            id="kpi-note"
            name="note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
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
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save value'}
        </button>
      </form>
    </section>
  );
}

function DefinitionEditForm({ onSaved }) {
  const { definitions, reload } = useDefinitions();
  const [key, setKey] = useState(KPIS[0].key);
  const [definition, setDefinition] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const current = definitions[key] || {};

  async function onSubmit(e) {
    e.preventDefault();
    setStatus(null);
    if (!definition.trim()) {
      setStatus({ ok: false, msg: 'Enter the revised definition.' });
      return;
    }
    setBusy(true);
    try {
      await submitDefinition(key, { definition: definition.trim() });
      setStatus({ ok: true, msg: `Definition for ${key} updated.` });
      setDefinition('');
      reload();
      if (onSaved) onSaved();
    } catch (err) {
      setStatus({
        ok: false,
        msg:
          err.status === 403
            ? 'Only the founder can edit definitions.'
            : 'Could not save the definition. Please try again.'
      });
    }
    setBusy(false);
  }

  return (
    <section className="panel" aria-labelledby="definition-heading">
      <h2 id="definition-heading">Edit a KPI definition</h2>
      <p className="kpi-card__note">
        Editing a definition flags the KPI card as{' '}
        <em>definition changed</em> for 90 days.
      </p>
      <form onSubmit={onSubmit} data-testid="definition-form">
        <div className="field">
          <label htmlFor="def-key">KPI</label>
          <select
            id="def-key"
            name="key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          >
            {KPIS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
        {current.definition ? (
          <p className="kpi-card__note" data-testid="current-definition">
            Current: {current.definition}
          </p>
        ) : null}
        <div className="field">
          <label htmlFor="def-text">Definition</label>
          <textarea
            id="def-text"
            name="definition"
            rows={3}
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            placeholder="How this KPI is measured…"
          />
        </div>
        {status ? (
          <p
            className={status.ok ? 'form-status form-status--ok' : 'auth__error'}
            role="status"
            data-testid="definition-status"
          >
            {status.msg}
          </p>
        ) : null}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save definition'}
        </button>
      </form>
    </section>
  );
}

function AuditTrail({ revision }) {
  const { entries, loading, reload } = useAudit();

  // Re-fetch when a sibling form bumps the revision after a successful write.
  useEffect(() => {
    if (revision > 0) reload();
  }, [revision, reload]);

  return (
    <section className="panel" aria-labelledby="audit-heading">
      <h2 id="audit-heading">Audit trail</h2>
      {loading ? (
        <p>Loading audit trail…</p>
      ) : entries.length === 0 ? (
        <p data-testid="audit-empty">No changes recorded yet.</p>
      ) : (
        <table className="audit-table" data-testid="audit-table">
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col">When</th>
              <th scope="col">Change</th>
              <th scope="col">Old</th>
              <th scope="col">New</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} data-testid="audit-row">
                <td data-col="who">{e.actor_email || '—'}</td>
                <td data-col="when">{formatWhen(e.created_at)}</td>
                <td data-col="change">{e.target}</td>
                <td data-col="old">{renderVal(e.old_value)}</td>
                <td data-col="new">{renderVal(e.new_value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function renderVal(v) {
  if (v === null || v === undefined || v === '') return '—';
  return String(v);
}

function formatWhen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
