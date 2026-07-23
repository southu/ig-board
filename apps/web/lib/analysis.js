'use client';

import { getSession } from './auth';

// Independent analysis client — calls the Fastify API only.
//
// Network target is always same-origin `/api/independent-analysis` (the Fastify
// route). There is no Next.js /api route and no Anthropic SDK or key in the
// browser. Failure simulation is a documented test-only query flag forwarded
// to the server (see TESTING.md).

const ANALYSIS_PATH = '/api/independent-analysis';

/**
 * Request an independent analysis from the Fastify API.
 * @param {{ simulateFailure?: boolean, memoId?: string }} [opts]
 * @returns {Promise<{ ok: true, analysis: object } | { ok: false, error: string, message: string, retryable: boolean, simulate?: boolean, status: number }>}
 */
export async function requestIndependentAnalysis(opts = {}) {
  const session = getSession();
  if (!session || !session.access_token) {
    return {
      ok: false,
      error: 'unauthenticated',
      message: 'Sign in to run independent analysis.',
      retryable: false,
      status: 401
    };
  }

  const params = new URLSearchParams();
  if (opts.simulateFailure) {
    params.set('simulate_anthropic_failure', '1');
  }
  const qs = params.toString();
  const url = qs ? `${ANALYSIS_PATH}?${qs}` : ANALYSIS_PATH;

  const body = {};
  if (opts.memoId) body.memo_id = opts.memoId;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      cache: 'no-store'
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        error: (payload && payload.error) || 'analysis_failed',
        message:
          (payload && payload.message) ||
          `Analysis request failed (${res.status}).`,
        retryable: !!(payload && payload.retryable) || res.status >= 500,
        simulate: !!(payload && payload.simulate),
        status: res.status
      };
    }

    return {
      ok: true,
      analysis: (payload && payload.analysis) || payload,
      status: res.status
    };
  } catch (err) {
    return {
      ok: false,
      error: 'network_error',
      message: (err && err.message) || 'Network error calling analysis API.',
      retryable: true,
      status: 0
    };
  }
}

// Minimal markdown → safe HTML for the five analysis sections.
// Escapes HTML first, then applies a small set of markdown transforms so we
// never inject raw HTML from the model into the DOM.
export function renderAnalysisMarkdown(markdown) {
  const raw = String(markdown || '');
  const escaped = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = escaped.split('\n');
  const html = [];
  let inList = false;

  function closeList() {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  }

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      closeList();
      const title = h2[1].trim();
      html.push(
        `<h2 class="analysis-section__heading" data-section="${attr(title)}">${inline(title)}</h2>`
      );
      continue;
    }
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      closeList();
      html.push(`<h3>${inline(h3[1].trim())}</h3>`);
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.+)$/) || line.match(/^\s*\d+\.\s+(.+)$/);
    if (li) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return html.join('\n');
}

function attr(s) {
  return String(s).replace(/"/g, '&quot;');
}

function inline(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// Read the documented test-only simulate flag from the page URL.
// ?simulate_anthropic_failure=1 (or simulate_failure=1) enables the first request
// to force a provider error so the retry UI can be exercised.
export function readSimulateFlagFromLocation() {
  if (typeof window === 'undefined') return false;
  try {
    const sp = new URLSearchParams(window.location.search);
    const v = (
      sp.get('simulate_anthropic_failure') ||
      sp.get('simulate_failure') ||
      ''
    ).toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  } catch {
    return false;
  }
}

// Strip the simulate query params from the current URL (no navigation).
export function clearSimulateFlagFromLocation() {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('simulate_anthropic_failure');
    url.searchParams.delete('simulate_failure');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  } catch {
    // ignore
  }
}
