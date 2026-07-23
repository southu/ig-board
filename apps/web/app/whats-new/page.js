'use client';

import { useEffect, useState } from 'react';
import AuthGuard from '../../components/AuthGuard';
import { getSession } from '../../lib/auth';

// Phase 4 digest: scorecard changes since the member's last_seen_at.
// Email-free — no mailto, no notification-subscribe chrome, no inbox copy.

export default function WhatsNewPage() {
  return (
    <AuthGuard>
      <WhatsNewContent />
    </AuthGuard>
  );
}

function WhatsNewContent() {
  const [state, setState] = useState({
    loading: true,
    error: null,
    last_seen_at: null,
    seen_at: null,
    items: []
  });

  useEffect(() => {
    let alive = true;
    const session = getSession();
    if (!session || !session.access_token) {
      setState((s) => ({
        ...s,
        loading: false,
        error: 'Sign in to see what changed.'
      }));
      return;
    }
    fetch('/api/whats-new', {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: 'no-store'
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            (body && body.message) || `Failed to load digest (${res.status})`
          );
        }
        return res.json();
      })
      .then((body) => {
        if (!alive) return;
        setState({
          loading: false,
          error: null,
          last_seen_at: body.last_seen_at || null,
          seen_at: body.seen_at || null,
          items: Array.isArray(body.items) ? body.items : []
        });
      })
      .catch((err) => {
        if (!alive) return;
        setState((s) => ({
          ...s,
          loading: false,
          error: (err && err.message) || 'Failed to load digest'
        }));
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div data-testid="whats-new-page">
      <p className="eyebrow">Since you last looked</p>
      <h1>What&apos;s new</h1>
      <p className="lede">
        A quiet digest of scorecard changes since your last visit. No email, no
        alerts — just the deltas when you open this page.
      </p>

      {state.loading && (
        <p className="route-guard" data-testid="whats-new-loading">
          Loading changes…
        </p>
      )}

      {state.error && (
        <p className="auth__error" data-testid="whats-new-error" role="alert">
          {state.error}
        </p>
      )}

      {!state.loading && !state.error && (
        <>
          <p className="whats-new__meta" data-testid="whats-new-meta">
            {state.last_seen_at
              ? `Previous visit: ${formatWhen(state.last_seen_at)} · `
              : 'First visit · '}
            {state.items.length === 0
              ? 'No new changes.'
              : `${state.items.length} change${
                  state.items.length === 1 ? '' : 's'
                }.`}
          </p>

          {state.items.length === 0 ? (
            <div className="panel whats-new__empty" data-testid="whats-new-empty">
              <p>You&apos;re caught up. Come back after the next KPI update.</p>
            </div>
          ) : (
            <ul className="whats-new__list" data-testid="whats-new-list">
              {state.items.map((item) => (
                <li
                  key={item.id}
                  className="whats-new__item"
                  data-testid="whats-new-item"
                  data-kind={item.kind || ''}
                  data-source={item.source || ''}
                >
                  <time
                    className="whats-new__when"
                    dateTime={item.created_at || undefined}
                  >
                    {formatWhen(item.created_at)}
                  </time>
                  <span className="whats-new__summary">{item.summary}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function formatWhen(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return String(iso);
  }
}
