'use client';

import { useEffect, useState } from 'react';
import AuthGuard from '../../components/AuthGuard';
import CommentThread from '../../components/CommentThread';
import { getSession } from '../../lib/auth';

// Founder memos surface (Phase 4 route). Board + founder can list; upload stays
// on the founder pipeline / API. Returns HTTP 200 HTML with content for the
// live tester's memos-route check.
export default function MemosPage() {
  return (
    <AuthGuard>
      <MemosContent />
    </AuthGuard>
  );
}

function MemosContent() {
  const [memos, setMemos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const session = getSession();
    if (!session || !session.access_token) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    fetch('/api/memos', {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store'
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((body) => {
        if (!cancelled) {
          setMemos((body && body.memos) || []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load memos');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="memos-page" data-testid="memos-page">
      <p className="eyebrow">Memos</p>
      <h1>Founder meeting memos</h1>
      <p className="lede">
        Private meeting notes available to the board. Founders upload via the
        memo pipeline; everyone signed in can read and discuss here.
      </p>

      {loading ? (
        <p className="comment-thread__muted">Loading memos…</p>
      ) : error ? (
        <p className="auth__error" role="alert">
          {error}
        </p>
      ) : memos.length === 0 ? (
        <div className="panel" data-testid="memos-empty">
          <p>
            No memos uploaded yet. Founders can upload a <code>.docx</code> or{' '}
            <code>.pdf</code> via <code>POST /api/memos</code>. Once present,
            each memo opens a discussion thread below.
          </p>
        </div>
      ) : (
        <ul className="agenda-list" data-testid="memos-list">
          {memos.map((m) => (
            <li key={m.id} className="panel" data-memo={m.id}>
              <h2 className="agenda-topic__title">
                {m.title || m.original_filename || m.id}
              </h2>
              <p className="agenda-meta">
                Meeting date: {m.meeting_date || '—'}
                {m.analyzed ? ' · analyzed' : ''}
              </p>
              <CommentThread
                target={{ memo_id: m.id }}
                title={`Discussion · ${m.title || m.id}`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
