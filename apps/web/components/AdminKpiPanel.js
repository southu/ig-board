'use client';

import { useEffect, useMemo, useState } from 'react';
import { KPIS } from '../lib/catalog';
import { useKpiValues } from '../lib/data';
import {
  useRole,
  useDefinitions,
  submitKpiValue,
  submitDefinition
} from '../lib/founder';

const MANUAL_ENTRY_KPIS = KPIS.filter(
  (kpi) => kpi.manualEntry !== false && kpi.type !== 'computed'
);

function defaultPeriod() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
}

// Admin-area KPI data management. Visibility of each form is derived only from
// the capability list returned by GET /me (same map the route guards use).
// board_member never reaches this panel (access_admin_area gate on /admin).
export default function AdminKpiPanel() {
  const { capabilities, loading } = useRole();

  if (loading) {
    return (
      <section className="panel admin-panel" data-testid="admin-kpi-panel">
        <p className="lede">Loading KPI capabilities…</p>
      </section>
    );
  }

  const canInput =
    Array.isArray(capabilities) && capabilities.includes('input_kpi_data');
  const canEdit =
    Array.isArray(capabilities) && capabilities.includes('edit_kpi_data');

  if (!canInput && !canEdit) {
    return null;
  }

  return (
    <div className="admin-kpi" data-testid="admin-kpi-panel">
      <section className="panel admin-panel" data-testid="admin-kpi-section">
        <h2>KPI data management</h2>
        <p className="lede">
          Add new KPI readings and edit existing values or definitions. Controls
          appear only for capabilities from the central permission map (
          <code>input_kpi_data</code>, <code>edit_kpi_data</code>).
        </p>
        <a
          className="btn btn--secondary"
          href="/api/admin/kpi-export.csv"
          data-testid="admin-kpi-export-download"
        >
          Download KPI CSV
        </a>
      </section>
      {canInput ? <AdminAddKpiForm /> : null}
      {canInput || canEdit ? (
        <AdminEditKpiValueForm canSubmit={canInput || canEdit} />
      ) : null}
      {canEdit ? <AdminEditDefinitionForm /> : null}
    </div>
  );
}

function AdminAddKpiForm() {
  const [key, setKey] = useState(MANUAL_ENTRY_KPIS[0].key);
  const [period, setPeriod] = useState(defaultPeriod());
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const { reload } = useKpiValues();

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
      setStatus({ ok: true, msg: `Added ${key} = ${value} for ${period}.` });
      setValue('');
      setNote('');
      if (reload) reload();
    } catch (err) {
      setStatus({
        ok: false,
        msg:
          err.status === 403
            ? 'You do not have permission to add KPI data.'
            : 'Could not add the KPI entry. Please try again.'
      });
    }
    setBusy(false);
  }

  return (
    <section
      className="panel admin-panel"
      data-testid="admin-kpi-add-panel"
      aria-labelledby="admin-kpi-add-heading"
    >
      <h2 id="admin-kpi-add-heading">Add KPI entry</h2>
      <p className="kpi-card__note">
        Creates a new reading via <code>POST /api/kpi-values</code> (
        <code>input_kpi_data</code>).
      </p>
      <form
        className="admin-form"
        onSubmit={onSubmit}
        data-testid="admin-kpi-add-form"
      >
        <div className="field">
          <label htmlFor="admin-kpi-add-key">KPI</label>
          <select
            id="admin-kpi-add-key"
            name="key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            data-testid="admin-kpi-add-key"
          >
            {MANUAL_ENTRY_KPIS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="admin-kpi-add-period">Period (month)</label>
          <input
            id="admin-kpi-add-period"
            name="period"
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            required
            data-testid="admin-kpi-add-period"
          />
        </div>
        <div className="field">
          <label htmlFor="admin-kpi-add-value">Value</label>
          <input
            id="admin-kpi-add-value"
            name="value"
            type="number"
            step="any"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            data-testid="admin-kpi-add-value"
          />
        </div>
        <div className="field">
          <label htmlFor="admin-kpi-add-note">Note (optional)</label>
          <input
            id="admin-kpi-add-note"
            name="note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="admin-kpi-add-note"
          />
        </div>
        {status ? (
          <p
            className={status.ok ? 'form-status form-status--ok' : 'auth__error'}
            role="status"
            data-testid="admin-kpi-add-status"
          >
            {status.msg}
          </p>
        ) : null}
        <button
          className="btn btn--primary"
          type="submit"
          disabled={busy}
          data-testid="admin-kpi-add-submit"
        >
          {busy ? 'Saving…' : 'Add KPI entry'}
        </button>
      </form>
    </section>
  );
}

function AdminEditKpiValueForm({ canSubmit }) {
  const { valuesByKey, reload } = useKpiValues();
  const [key, setKey] = useState(MANUAL_ENTRY_KPIS[0].key);
  const [period, setPeriod] = useState('');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const series = useMemo(() => {
    const raw = (valuesByKey && valuesByKey[key]) || [];
    return Array.isArray(raw)
      ? [...raw].sort((a, b) => String(b.period).localeCompare(String(a.period)))
      : [];
  }, [valuesByKey, key]);

  // When KPI or series changes, select the latest observation and prefill.
  useEffect(() => {
    if (!series.length) {
      setPeriod('');
      setValue('');
      return;
    }
    const latest = series[0];
    const p = String(latest.period).slice(0, 7);
    setPeriod(p);
    setValue(latest.value != null ? String(latest.value) : '');
  }, [key, series]);

  function onPeriodChange(nextPeriod) {
    setPeriod(nextPeriod);
    const hit = series.find(
      (p) => String(p.period).slice(0, 7) === nextPeriod
    );
    if (hit && hit.value != null) {
      setValue(String(hit.value));
    }
  }

  async function onSubmit(e) {
    e.preventDefault();
    setStatus(null);
    if (!canSubmit) {
      setStatus({ ok: false, msg: 'You do not have permission to edit values.' });
      return;
    }
    if (!period) {
      setStatus({ ok: false, msg: 'Select an existing period to edit.' });
      return;
    }
    if (value === '' || Number.isNaN(Number(value))) {
      setStatus({ ok: false, msg: 'Enter a numeric value.' });
      return;
    }
    setBusy(true);
    try {
      // Value upsert uses the input_kpi_data-guarded POST endpoint (same store
      // path as add). Period is constrained to existing observations so this
      // form only updates readings already on the scorecard.
      await submitKpiValue({ key, period, value, note });
      setStatus({
        ok: true,
        msg: `Updated ${key} for ${period} to ${value}.`
      });
      setNote('');
      if (reload) reload();
    } catch (err) {
      setStatus({
        ok: false,
        msg:
          err.status === 403
            ? 'You do not have permission to edit KPI values.'
            : 'Could not update the KPI value. Please try again.'
      });
    }
    setBusy(false);
  }

  return (
    <section
      className="panel admin-panel"
      data-testid="admin-kpi-edit-value-panel"
      aria-labelledby="admin-kpi-edit-value-heading"
    >
      <h2 id="admin-kpi-edit-value-heading">Edit existing KPI value</h2>
      <p className="kpi-card__note">
        Choose a KPI and period already on the scorecard, then save a new
        reading. Updates appear immediately in KPI data shown by the app.
      </p>
      <form
        className="admin-form"
        onSubmit={onSubmit}
        data-testid="admin-kpi-edit-value-form"
      >
        <div className="field">
          <label htmlFor="admin-kpi-edit-key">KPI</label>
          <select
            id="admin-kpi-edit-key"
            name="key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            data-testid="admin-kpi-edit-key"
          >
            {MANUAL_ENTRY_KPIS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="admin-kpi-edit-period">Existing period</label>
          {series.length ? (
            <select
              id="admin-kpi-edit-period"
              name="period"
              value={period}
              onChange={(e) => onPeriodChange(e.target.value)}
              data-testid="admin-kpi-edit-period"
            >
              {series.map((p) => {
                const ym = String(p.period).slice(0, 7);
                return (
                  <option key={String(p.period)} value={ym}>
                    {ym} (current: {p.value})
                  </option>
                );
              })}
            </select>
          ) : (
            <p className="kpi-card__note" data-testid="admin-kpi-edit-empty">
              No existing values for this KPI yet — use Add KPI entry first.
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="admin-kpi-edit-value">New value</label>
          <input
            id="admin-kpi-edit-value"
            name="value"
            type="number"
            step="any"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
            disabled={!series.length}
            data-testid="admin-kpi-edit-value"
          />
        </div>
        <div className="field">
          <label htmlFor="admin-kpi-edit-note">Note (optional)</label>
          <input
            id="admin-kpi-edit-note"
            name="note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={!series.length}
            data-testid="admin-kpi-edit-note"
          />
        </div>
        {status ? (
          <p
            className={status.ok ? 'form-status form-status--ok' : 'auth__error'}
            role="status"
            data-testid="admin-kpi-edit-value-status"
          >
            {status.msg}
          </p>
        ) : null}
        <button
          className="btn btn--primary"
          type="submit"
          disabled={busy || !series.length}
          data-testid="admin-kpi-edit-value-submit"
        >
          {busy ? 'Saving…' : 'Save value change'}
        </button>
      </form>
    </section>
  );
}

function AdminEditDefinitionForm() {
  const { definitions, reload } = useDefinitions();
  const [key, setKey] = useState(KPIS[0].key);
  const [definition, setDefinition] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const current = definitions[key] || {};
  const catalog = KPIS.find((k) => k.key === key);

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
    } catch (err) {
      setStatus({
        ok: false,
        msg:
          err.status === 403
            ? 'You do not have permission to edit KPI definitions.'
            : 'Could not save the definition. Please try again.'
      });
    }
    setBusy(false);
  }

  return (
    <section
      className="panel admin-panel"
      data-testid="admin-kpi-edit-definition-panel"
      aria-labelledby="admin-kpi-edit-definition-heading"
    >
      <h2 id="admin-kpi-edit-definition-heading">Edit KPI definition</h2>
      <p className="kpi-card__note">
        Updates definition prose via{' '}
        <code>PUT /api/kpi-definitions/:key</code> (
        <code>edit_kpi_data</code>). Flags the KPI as definition-changed for 90
        days.
      </p>
      <form
        className="admin-form"
        onSubmit={onSubmit}
        data-testid="admin-kpi-edit-definition-form"
      >
        <div className="field">
          <label htmlFor="admin-kpi-def-key">KPI</label>
          <select
            id="admin-kpi-def-key"
            name="key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            data-testid="admin-kpi-def-key"
          >
            {KPIS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
        <p className="kpi-card__note" data-testid="admin-kpi-def-current">
          Current:{' '}
          {current.definition ||
            (catalog && catalog.definition) ||
            'No custom definition stored yet.'}
        </p>
        <div className="field">
          <label htmlFor="admin-kpi-def-text">New definition</label>
          <textarea
            id="admin-kpi-def-text"
            name="definition"
            rows={3}
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            placeholder="How this KPI is measured…"
            data-testid="admin-kpi-def-text"
          />
        </div>
        {status ? (
          <p
            className={status.ok ? 'form-status form-status--ok' : 'auth__error'}
            role="status"
            data-testid="admin-kpi-def-status"
          >
            {status.msg}
          </p>
        ) : null}
        <button
          className="btn btn--primary"
          type="submit"
          disabled={busy}
          data-testid="admin-kpi-def-submit"
        >
          {busy ? 'Saving…' : 'Save definition'}
        </button>
      </form>
    </section>
  );
}
