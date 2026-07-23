'use client';

import Link from 'next/link';
import AuthGuard from '../../components/AuthGuard';
import CommentThread from '../../components/CommentThread';
import { INDEPENDENT_ANALYSIS_ID } from '../../lib/comments';

// Comments hub (Phase 4 route). Surfaces polymorphic threads (analysis +
// pointer to KPI / memo discussion). HTTP 200 with content for the live tester.
export default function CommentsPage() {
  return (
    <AuthGuard>
      <CommentsContent />
    </AuthGuard>
  );
}

function CommentsContent() {
  return (
    <div className="comments-page" data-testid="comments-page">
      <p className="eyebrow">Comments</p>
      <h1>Board discussion</h1>
      <p className="lede">
        Threaded comments attach to a KPI, a memo, or independent analysis.
        Resolve open items from the thread; @mentions notify the named person.
      </p>

      <section className="panel" data-testid="comments-analysis">
        <h2>Independent analysis</h2>
        <p className="kpi-card__note">
          Discussion on the latest independent analysis. Open the full report on
          the <Link href="/analysis">analysis</Link> page.
        </p>
        <CommentThread
          target={{ analysis_id: INDEPENDENT_ANALYSIS_ID }}
          title="Analysis discussion"
        />
      </section>

      <section className="panel" data-testid="comments-pointers">
        <h2>Where else to comment</h2>
        <ul>
          <li>
            <Link href="/layer/1">Layer detail</Link> — each KPI card has its
            own thread (and a full <Link href="/kpi/cash_runway_months">trend</Link>
            ).
          </li>
          <li>
            <Link href="/memos">Memos</Link> — discussion per uploaded meeting
            memo.
          </li>
          <li>
            <Link href="/agenda">Agenda</Link> — open comments also feed the
            board agenda generator.
          </li>
        </ul>
      </section>
    </div>
  );
}
