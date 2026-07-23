'use client';

import { useCallback, useEffect, useState } from 'react';
import AuthGuard from '../../components/AuthGuard';
import { useRole } from '../../lib/founder';
import {
  fetchAgenda,
  regenerateAgenda,
  saveAgendaEdit,
  topicsToEditText
} from '../../lib/agenda';

export default function AgendaPage() {
  return (
    <AuthGuard>
      <AgendaContent />
    </AuthGuard>
  );
}

function AgendaContent() {
  const { role } = useRole();
  const isFounder = role === 'founder';
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [agenda, setAgenda] = useState(null);
  const [error, setError] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [saveState, setSaveState] = useState('idle'); // idle | saving | saved | error

  const applyAgenda = useCallback((next) => {
    setAgenda(next);
    // Prefer existing edited_content for the editor; otherwise seed from generated.
    if (next && next.edited_content != null && next.edited_content !== '') {
      setEditDraft(
        typeof next.edited_content === 'string'
          ? next.edited_content
          : JSON.stringify(next.edited_content, null, 2)
      );
    } else {
      const topics =
        (next && next.generated_content && next.generated_content.topics) || [];
      setEditDraft(topicsToEditText(topics));
    }
  }, []);

  const load = useCallback(async () => {
    setStatus('loading');
    setError(null);
    const result = await fetchAgenda();
    if (!result.ok) {
      setError(result.message || 'Failed to load agenda.');
      setStatus('error');
      return;
    }
    applyAgenda(result.agenda);
    setStatus('ready');
  }, [applyAgenda]);

  useEffect(() => {
    load();
  }, [load]);

  async function onRegenerate() {
    setStatus('loading');
    setError(null);
    const result = await regenerateAgenda();
    if (!result.ok) {
      setError(result.message || 'Regenerate failed.');
      setStatus('error');
      return;
    }
    applyAgenda(result.agenda);
    setStatus('ready');
  }

  async function onSaveEdit() {
    if (!isFounder) return;
    setSaveState('saving');
    const result = await saveAgendaEdit(editDraft);
    if (!result.ok) {
      setSaveState('error');
      setError(result.message || 'Save failed.');
      return;
    }
    applyAgenda(result.agenda);
    setSaveState('saved');
    setTimeout(() => setSaveState('idle'), 2000);
  }

  const topics =
    (agenda && agenda.generated_content && agenda.generated_content.topics) ||
    [];
  const sources =
    (agenda && agenda.generated_content && agenda.generated_content.sources) ||
    {};

  return (
    <div className="agenda-page" data-testid="agenda-page">
      <p className="eyebrow">Board meeting</p>
      <h1 data-testid="agenda-title">Agenda</h1>
      <p className="lede">
        Time-blocked topics assembled from red/yellow KPIs, unresolved comments,
        and the latest independent analysis questions — ordered bottom-up through
        the pyramid (Leadership Alignment first, Enterprise Value last).
      </p>

      <div className="agenda-toolbar">
        <button
          type="button"
          className="btn btn--secondary"
          data-testid="agenda-regenerate"
          onClick={onRegenerate}
          disabled={status === 'loading'}
        >
          {status === 'loading' ? 'Generating…' : 'Regenerate'}
        </button>
        {agenda && agenda.generated_at ? (
          <span className="agenda-meta" data-testid="agenda-generated-at">
            Generated {new Date(agenda.generated_at).toLocaleString()}
          </span>
        ) : null}
      </div>

      {status === 'error' && error ? (
        <div className="agenda-error" data-testid="agenda-error" role="alert">
          {error}
        </div>
      ) : null}

      {status === 'ready' || topics.length > 0 ? (
        <>
          <section
            className="agenda-topics panel"
            data-testid="agenda-topics"
            aria-label="Time-blocked agenda topics"
          >
            {topics.length === 0 ? (
              <p className="agenda-empty" data-testid="agenda-empty">
                No topics yet — all KPIs are on track and there are no open
                comments or board questions.
              </p>
            ) : (
              <ol className="agenda-list">
                {topics.map((t) => (
                  <li
                    key={t.id}
                    className="agenda-topic"
                    data-testid="agenda-topic"
                    data-layer={t.layer}
                    data-layer-name={t.layer_name}
                    data-source={t.source}
                    data-comment-id={t.comment_id || undefined}
                    data-kpi-key={t.kpi_key || undefined}
                  >
                    <div className="agenda-topic__time" data-testid="agenda-time-block">
                      {t.time_block}
                    </div>
                    <div className="agenda-topic__body">
                      <div className="agenda-topic__meta">
                        <span
                          className="agenda-layer-chip"
                          data-testid="agenda-layer-name"
                        >
                          {t.layer_name}
                        </span>
                        <span className="agenda-source-chip">{t.source}</span>
                        {t.status ? (
                          <span className={`rag-chip rag-chip--${t.status}`}>
                            {t.status}
                          </span>
                        ) : null}
                      </div>
                      <h2 className="agenda-topic__title">{t.title}</h2>
                      <p className="agenda-topic__text">{t.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <p className="agenda-sources" data-testid="agenda-sources">
              Sources: {sources.red_yellow_kpis ?? 0} red/yellow KPI
              {(sources.red_yellow_kpis || 0) === 1 ? '' : 's'},{' '}
              {sources.unresolved_comments ?? 0} unresolved comment
              {(sources.unresolved_comments || 0) === 1 ? '' : 's'},{' '}
              {sources.analysis_questions ?? 0} analysis question
              {(sources.analysis_questions || 0) === 1 ? '' : 's'}.
            </p>
          </section>

          <section
            className="agenda-edit panel"
            data-testid="agenda-edit-section"
          >
            <h2 className="agenda-edit__heading">Edited content</h2>
            <p className="agenda-edit__hint">
              Edits are stored separately from the generated original. Regenerating
              refreshes generated topics only — your edits stay intact.
            </p>
            <textarea
              className="agenda-edit__textarea"
              data-testid="agenda-edited-content"
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              rows={12}
              readOnly={!isFounder}
              aria-label="Edited agenda content"
            />
            {isFounder ? (
              <div className="agenda-edit__actions">
                <button
                  type="button"
                  className="btn"
                  data-testid="agenda-save-edit"
                  onClick={onSaveEdit}
                  disabled={saveState === 'saving'}
                >
                  {saveState === 'saving'
                    ? 'Saving…'
                    : saveState === 'saved'
                      ? 'Saved'
                      : 'Save edits'}
                </button>
                {agenda && agenda.edited_content != null ? (
                  <span
                    className="agenda-edit__saved-flag"
                    data-testid="agenda-has-edited"
                  >
                    Edited content on file
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="agenda-edit__hint">Board members can view edits; founders save them.</p>
            )}

            {/* Always expose generated original so tests (and humans) can confirm
                it was not clobbered by an edit. */}
            <details className="agenda-generated-details">
              <summary data-testid="agenda-generated-summary">
                Generated original (read-only)
              </summary>
              <pre
                className="agenda-generated-pre"
                data-testid="agenda-generated-content"
              >
                {JSON.stringify(
                  (agenda && agenda.generated_content) || {},
                  null,
                  2
                )}
              </pre>
            </details>
          </section>
        </>
      ) : status === 'loading' ? (
        <p className="agenda-loading" data-testid="agenda-loading">
          Assembling agenda…
        </p>
      ) : null}
    </div>
  );
}
