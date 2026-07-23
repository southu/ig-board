'use client';

import { useState } from 'react';
import { useRole } from '../lib/founder';
import { getSession } from '../lib/auth';

// Board-only chrome: CSV export of all kpi_values + What's new digest. Rendered
// ONLY when the signed-in member resolves as role 'board' — founder and guests
// never see an Export entry point (acceptance: non-board cannot download CSV
// via missing UI or 401/403).

async function downloadKpiCsv() {
  const session = getSession();
  if (!session || !session.access_token) {
    throw new Error('unauthenticated');
  }
  const res = await fetch('/api/export/kpi-values.csv', {
    headers: { Authorization: `Bearer ${session.access_token}` },
    cache: 'no-store'
  });
  if (!res.ok) {
    const err = new Error('export failed');
    err.status = res.status;
    throw err;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'kpi-values.csv';
  a.setAttribute('data-testid', 'csv-download-anchor');
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function BoardNav() {
  const { role } = useRole();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (role !== 'board') return null;

  async function onExport(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await downloadKpiCsv();
    } catch (err) {
      setError(err && err.status === 403 ? 'Export denied' : 'Export failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="nav-link nav-link--button"
        data-testid="board-csv-export"
        onClick={onExport}
        disabled={busy}
        aria-busy={busy ? 'true' : 'false'}
      >
        {busy ? 'Exporting…' : 'Export CSV'}
      </button>
      {error ? (
        <span className="nav-error" data-testid="board-csv-error" role="status">
          {error}
        </span>
      ) : null}
    </>
  );
}
