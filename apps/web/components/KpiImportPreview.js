'use client';

import { useState } from 'react';
import { getSession } from '../lib/auth';

function headers() {
  const token = getSession()?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function KpiImportPreview() {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [committing, setCommitting] = useState(false);
  async function submit(event) {
    event.preventDefault(); setError(''); setPreview(null);
    if (!file) { setError('Choose a CSV file.'); return; }
    setBusy(true);
    try {
      const form = new FormData(); form.append('file', file, file.name);
      const response = await fetch('/api/admin/kpi-import/preview', { method: 'POST', headers: headers(), body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || body.error || 'Preview failed.');
      setPreview(body);
    } catch (err) { setError(err.message || 'Preview failed.'); }
    setBusy(false);
  }
  async function commit() {
    if (!preview?.archive?.id || preview.counts?.rejected) return;
    setError(''); setCommitting(true);
    try {
      const response = await fetch('/api/admin/kpi-import/commit', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ archive_id: preview.archive.id }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && !body.outcome) throw new Error(body.message || body.error || 'Commit failed.');
      setPreview((current) => ({ ...current, archive: body.archive || current.archive, final: { outcome: body.outcome, counts: body.counts, errors: body.errors || [] } }));
    } catch (err) { setError(err.message || 'Commit failed.'); }
    setCommitting(false);
  }
  return <section className="panel admin-panel" data-testid="kpi-import-preview">
    <h2>KPI CSV upload preview</h2>
    <p className="kpi-card__note">Original upload bytes are archived before validation. Preview never changes KPI or member records.</p>
    <form className="admin-form" onSubmit={submit}>
      <label className="field" htmlFor="kpi-import-file">KPI CSV file
        <input id="kpi-import-file" data-testid="kpi-import-file" type="file" accept=".csv,text/csv" onChange={(event) => setFile(event.target.files?.[0] || null)} />
      </label>
      <button className="btn btn--primary" type="submit" disabled={busy} data-testid="kpi-import-preview-submit">{busy ? 'Previewing…' : 'Preview CSV'}</button>
    </form>
    {error ? <p className="auth__error" role="alert">{error}</p> : null}
    {preview ? <div data-testid="kpi-import-results">
      <p className="form-status form-status--ok">Preview complete. Archive {preview.archive?.id} ({preview.archive?.created_at})</p>
      <dl className="kpi-import-counts"><dt>Added</dt><dd>{preview.counts.added}</dd><dt>Updated</dt><dd>{preview.counts.updated}</dd><dt>Unchanged</dt><dd>{preview.counts.unchanged}</dd><dt>Rejected</dt><dd>{preview.counts.rejected}</dd></dl>
      {!preview.final && preview.counts.rejected === 0 ? <button className="btn btn--primary" type="button" onClick={commit} disabled={committing} data-testid="kpi-import-commit-submit">{committing ? 'Committing…' : 'Commit validated import'}</button> : null}
      {preview.final ? <div data-testid="kpi-import-final-result"><p className={preview.final.outcome === 'committed' ? 'form-status form-status--ok' : 'auth__error'}>Final result: {preview.final.outcome}</p><dl className="kpi-import-counts"><dt>Added</dt><dd>{preview.final.counts?.added}</dd><dt>Updated</dt><dd>{preview.final.counts?.updated}</dd><dt>Unchanged</dt><dd>{preview.final.counts?.unchanged}</dd><dt>Rejected</dt><dd>{preview.final.counts?.rejected}</dd></dl>{preview.final.errors?.length ? <p>{preview.final.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}</p> : null}</div> : null}
      <table><thead><tr><th>Source row</th><th>Classification</th><th>Problems</th></tr></thead><tbody>{preview.rows.map((row) => <tr key={row.source_row}><td>{row.source_row}</td><td>{row.classification}</td><td>{row.errors.map((e) => `${e.code}: ${e.message}`).join('; ') || '—'}</td></tr>)}</tbody></table>
    </div> : null}
  </section>;
}
