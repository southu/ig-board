'use client';

import { useCallback, useEffect, useState } from 'react';
import { getSession } from '../lib/auth';

function headers() {
  const token = getSession()?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function Counts({ counts = {} }) {
  return <span>Added {counts.added || 0} · Updated {counts.updated || 0} · Unchanged {counts.unchanged || 0} · Rejected {counts.rejected || 0}</span>;
}

export default function KpiImportArchive() {
  const [archives, setArchives] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/kpi-import/archives', { headers: headers(), cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Could not load archive.');
      setArchives(Array.isArray(body.archives) ? body.archives : []);
    } catch { setError('Could not load upload archive.'); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function open(item) {
    try {
      const response = await fetch(item.detail_url, { headers: headers(), cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error();
      setSelected(body);
    } catch { setError('Could not load archive entry.'); }
  }
  async function downloadOriginal() {
    if (!selected?.download_url || downloading) return;
    setError('');
    setDownloading(true);
    try {
      // A normal anchor navigation cannot include the in-memory bearer token
      // used by the rest of the admin console. Fetch the original through the
      // same authenticated boundary, then hand the unchanged response bytes to
      // the browser as a download.
      const response = await fetch(selected.download_url, {
        headers: headers(),
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('download unavailable');
      const bytes = await response.blob();
      const url = URL.createObjectURL(bytes);
      const link = document.createElement('a');
      link.href = url;
      link.download = selected.original_filename || 'import.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      // The API deliberately keeps unavailable-object responses non-specific;
      // retain that boundary in the admin UI too.
      setError('Original CSV is unavailable.');
    } finally {
      setDownloading(false);
    }
  }
  return <section className="panel admin-panel" data-testid="kpi-import-archive">
    <h2>KPI CSV upload archive</h2>
    <p className="kpi-card__note">Upload attempts are shown newest first. Original CSV downloads are restricted to administrators.</p>
    {error ? <p className="auth__error" role="alert">{error}</p> : null}
    <table><thead><tr><th>Timestamp</th><th>Administrator</th><th>Filename</th><th>Status</th><th>Results</th><th>Archive</th></tr></thead><tbody>
      {archives.map((item) => <tr key={item.id}><td>{item.created_at}</td><td>{item.administrator?.name || item.administrator?.email || 'Unknown'}</td><td>{item.original_filename}</td><td>{item.final?.outcome || item.outcome}</td><td><Counts counts={item.final?.counts || item.counts} /></td><td><button className="btn btn--secondary" type="button" onClick={() => open(item)}>View details</button></td></tr>)}
      {!archives.length ? <tr><td colSpan="6">No KPI CSV upload attempts yet.</td></tr> : null}
    </tbody></table>
    {selected ? <div data-testid="kpi-import-archive-detail"><h3>Upload details: {selected.original_filename}</h3><p><Counts counts={selected.final?.counts || selected.counts} /></p><button className="btn btn--secondary" type="button" onClick={downloadOriginal} disabled={downloading} data-testid="kpi-import-archive-download">{downloading ? 'Downloading…' : 'Download original CSV'}</button>{selected.validation_errors?.length ? <ul>{selected.validation_errors.map((entry, index) => <li key={`${entry.row}-${entry.field}-${index}`}>Row {entry.row}: {entry.field} — {entry.message}</li>)}</ul> : <p>No row-level validation errors.</p>}</div> : null}
  </section>;
}
