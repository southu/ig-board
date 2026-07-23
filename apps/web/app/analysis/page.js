'use client';

import { useCallback, useEffect, useState } from 'react';
import AuthGuard from '../../components/AuthGuard';
import {
  requestIndependentAnalysis,
  renderAnalysisMarkdown,
  readSimulateFlagFromLocation,
  clearSimulateFlagFromLocation
} from '../../lib/analysis';

// Exact page label required by acceptance (light + dark).
export const ANALYSIS_PAGE_LABEL = 'Independent Analysis (AI-generated)';

// Independent Analysis page. Auth-guarded. Calls Fastify
// POST /api/independent-analysis only (never a Next.js route, never Anthropic
// from the browser). Documented failure simulation: open with
// ?simulate_anthropic_failure=1 — shows retry state; retry clears the flag and
// re-requests a successful analysis (see TESTING.md).
export default function AnalysisPage() {
  return (
    <AuthGuard>
      <AnalysisContent />
    </AuthGuard>
  );
}

function AnalysisContent() {
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [markdown, setMarkdown] = useState('');
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [simulate, setSimulate] = useState(false);

  const run = useCallback(async (opts = {}) => {
    setStatus('loading');
    setError(null);
    const useSimulate =
      opts.simulateFailure === true ||
      (opts.simulateFailure !== false && simulate);
    const result = await requestIndependentAnalysis({
      simulateFailure: useSimulate
    });
    if (result.ok) {
      setMarkdown((result.analysis && result.analysis.markdown) || '');
      setMeta(result.analysis || null);
      setStatus('ready');
      setSimulate(false);
      clearSimulateFlagFromLocation();
      return;
    }
    setError({
      message: result.message || 'Analysis failed.',
      error: result.error,
      retryable: result.retryable !== false,
      simulate: !!result.simulate
    });
    setStatus('error');
  }, [simulate]);

  useEffect(() => {
    const sim = readSimulateFlagFromLocation();
    setSimulate(sim);
    // Kick off analysis once on mount (with optional test-only simulation).
    (async () => {
      setStatus('loading');
      setError(null);
      const result = await requestIndependentAnalysis({
        simulateFailure: sim
      });
      if (result.ok) {
        setMarkdown((result.analysis && result.analysis.markdown) || '');
        setMeta(result.analysis || null);
        setStatus('ready');
        setSimulate(false);
        clearSimulateFlagFromLocation();
        return;
      }
      setError({
        message: result.message || 'Analysis failed.',
        error: result.error,
        retryable: result.retryable !== false,
        simulate: !!result.simulate
      });
      // Keep simulate true only while the failure was simulated — retry will
      // disable it so the next attempt succeeds.
      if (result.simulate) setSimulate(true);
      setStatus('error');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onRetry() {
    // Documented recovery: disable simulation, then re-request.
    setSimulate(false);
    clearSimulateFlagFromLocation();
    run({ simulateFailure: false });
  }

  return (
    <div className="analysis-page" data-testid="analysis-page">
      <p className="eyebrow">Board · AI</p>
      <h1 data-testid="analysis-page-label">{ANALYSIS_PAGE_LABEL}</h1>
      <p className="lede">
        An independent read of the scorecard and founder memos — slippage,
        attribution, nearly-complete claims, and concentration exposure. Generated
        server-side; the browser never holds provider keys.
      </p>

      {status === 'loading' && (
        <div
          className="analysis-status analysis-status--loading"
          data-testid="analysis-loading"
          aria-busy="true"
        >
          Generating independent analysis…
        </div>
      )}

      {status === 'error' && error && (
        <div
          className="analysis-status analysis-status--error"
          data-testid="analysis-retry-state"
          role="alert"
        >
          <p className="analysis-status__title">Analysis unavailable</p>
          <p data-testid="analysis-error-message">{error.message}</p>
          {error.simulate && (
            <p className="analysis-status__hint" data-testid="analysis-simulate-hint">
              Simulated provider failure is active (test-only). Retry disables
              simulation and requests a real analysis.
            </p>
          )}
          {error.retryable && (
            <button
              type="button"
              className="btn btn--primary"
              data-testid="analysis-retry"
              onClick={onRetry}
            >
              Retry analysis
            </button>
          )}
        </div>
      )}

      {status === 'ready' && markdown && (
        <article
          className="analysis-body panel"
          data-testid="analysis-body"
          data-source={meta && meta.source ? meta.source : undefined}
          data-model={meta && meta.model ? meta.model : undefined}
        >
          <div
            className="analysis-markdown"
            data-testid="analysis-markdown"
            dangerouslySetInnerHTML={{
              __html: renderAnalysisMarkdown(markdown)
            }}
          />
        </article>
      )}
    </div>
  );
}
