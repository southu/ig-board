'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  fetchComments,
  postComment,
  setCommentResolved,
  nestComments,
  renderCommentBody
} from '../lib/comments';

// Threaded comments UI for a single polymorphic target:
//   { kpi_id } | { memo_id } | { analysis_id }
// Features: list (persists via API), post, reply (parent_id), resolve/unresolve,
// bold @mention rendering. No email/push notifications.
export default function CommentThread({ target, title = 'Comments' }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null); // comment id or null
  const [busy, setBusy] = useState(false);

  const targetKey = target
    ? target.kpi_id || target.memo_id || target.analysis_id || ''
    : '';
  const targetKind = target
    ? target.kpi_id
      ? 'kpi'
      : target.memo_id
        ? 'memo'
        : target.analysis_id
          ? 'analysis'
          : ''
    : '';

  const reload = useCallback(async () => {
    if (!targetKey || !targetKind) {
      setComments([]);
      setLoading(false);
      return;
    }
    const filter =
      targetKind === 'kpi'
        ? { kpi_id: targetKey }
        : targetKind === 'memo'
          ? { memo_id: targetKey }
          : { analysis_id: targetKey };
    setLoading(true);
    setError(null);
    try {
      const data = await fetchComments(filter);
      setComments((data && data.comments) || []);
    } catch (err) {
      setError(
        err && err.status === 401
          ? 'Sign in to view comments.'
          : 'Could not load comments.'
      );
      setComments([]);
    }
    setLoading(false);
  }, [targetKey, targetKind]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function onSubmit(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const filter =
        targetKind === 'kpi'
          ? { kpi_id: targetKey }
          : targetKind === 'memo'
            ? { memo_id: targetKey }
            : { analysis_id: targetKey };
      await postComment({
        body,
        parent_id: replyTo || undefined,
        ...filter
      });
      setDraft('');
      setReplyTo(null);
      await reload();
    } catch (err) {
      setError(
        err && (err.status === 401 || err.status === 403)
          ? 'Sign in required to comment.'
          : 'Could not post comment.'
      );
    }
    setBusy(false);
  }

  async function onToggleResolve(comment) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setCommentResolved(comment.id, !comment.resolved);
      await reload();
    } catch (err) {
      setError(
        err && (err.status === 401 || err.status === 403)
          ? 'Sign in required to resolve comments.'
          : 'Could not update resolve state.'
      );
    }
    setBusy(false);
  }

  const tree = nestComments(comments);
  const entityAttr = target.kpi_id
    ? { 'data-comment-kpi': target.kpi_id }
    : target.memo_id
      ? { 'data-comment-memo': target.memo_id }
      : target.analysis_id
        ? { 'data-comment-analysis': target.analysis_id }
        : {};

  return (
    <section
      className="comment-thread"
      data-testid="comment-thread"
      aria-label={title}
      {...entityAttr}
    >
      <header className="comment-thread__head">
        <h3 className="comment-thread__title">{title}</h3>
        {comments.length > 0 ? (
          <span className="comment-thread__count" data-testid="comment-count">
            {comments.length}
          </span>
        ) : null}
      </header>

      {loading ? (
        <p className="comment-thread__muted" data-testid="comment-loading">
          Loading comments…
        </p>
      ) : null}

      {error ? (
        <p className="comment-thread__error" role="alert" data-testid="comment-error">
          {error}
        </p>
      ) : null}

      {!loading && tree.length === 0 ? (
        <p className="comment-thread__muted" data-testid="comment-empty">
          No comments yet. Start the thread below.
        </p>
      ) : null}

      <ul className="comment-list" data-testid="comment-list">
        {tree.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            depth={0}
            onReply={(id) => setReplyTo(id)}
            onToggleResolve={onToggleResolve}
          />
        ))}
      </ul>

      <form
        className="comment-compose"
        onSubmit={onSubmit}
        data-testid="comment-form"
      >
        {replyTo ? (
          <p className="comment-compose__replying" data-testid="comment-replying">
            Replying to a comment{' '}
            <button
              type="button"
              className="comment-compose__cancel"
              onClick={() => setReplyTo(null)}
            >
              Cancel
            </button>
          </p>
        ) : null}
        <label className="visually-hidden" htmlFor={`comment-body-${targetKey}`}>
          Comment body
        </label>
        <textarea
          id={`comment-body-${targetKey}`}
          name="body"
          className="comment-compose__input"
          data-testid="comment-input"
          rows={3}
          placeholder="Add a comment… Use @name to mention (shown in bold)."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          required
        />
        <div className="comment-compose__actions">
          <button
            type="submit"
            className="btn btn--primary"
            data-testid="comment-submit"
            disabled={busy || !draft.trim()}
          >
            {replyTo ? 'Post reply' : 'Post comment'}
          </button>
        </div>
      </form>
    </section>
  );
}

function CommentItem({ comment, depth, onReply, onToggleResolve }) {
  const isReply = depth > 0;
  return (
    <li
      className={`comment-item${comment.resolved ? ' comment-item--resolved' : ''}${
        isReply ? ' comment-item--reply' : ''
      }`}
      data-testid="comment-item"
      data-comment-id={comment.id}
      data-parent-id={comment.parent_id || ''}
      data-resolved={comment.resolved ? 'true' : 'false'}
    >
      <div className="comment-item__meta">
        <span className="comment-item__author" data-testid="comment-author">
          {comment.author_email || comment.author_id || 'Member'}
        </span>
        {comment.author_role ? (
          <span className="comment-item__role">{comment.author_role}</span>
        ) : null}
        {comment.resolved ? (
          <span className="comment-item__badge" data-testid="comment-resolved-badge">
            Resolved
          </span>
        ) : null}
      </div>
      <div
        className="comment-item__body"
        data-testid="comment-body"
        dangerouslySetInnerHTML={{ __html: renderCommentBody(comment.body) }}
      />
      <div className="comment-item__actions">
        <button
          type="button"
          className="comment-item__btn"
          data-testid="comment-reply-btn"
          onClick={() => onReply(comment.id)}
        >
          Reply
        </button>
        <button
          type="button"
          className="comment-item__btn"
          data-testid="comment-resolve-btn"
          onClick={() => onToggleResolve(comment)}
        >
          {comment.resolved ? 'Unresolve' : 'Resolve'}
        </button>
      </div>
      {comment.replies && comment.replies.length > 0 ? (
        <ul className="comment-list comment-list--nested">
          {comment.replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              depth={depth + 1}
              onReply={onReply}
              onToggleResolve={onToggleResolve}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
