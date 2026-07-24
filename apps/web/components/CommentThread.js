'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  fetchComments,
  postComment,
  setCommentResolved,
  setCommentReaction,
  deleteComment,
  applyReactionLocally,
  nestComments,
  renderCommentBody
} from '../lib/comments';
import { useRole } from '../lib/founder';

// Reaction catalog: small icon + count buttons. Types match the API
// (like | dislike | question). Icons are plain text so they track the
// existing boardroom type scale without a new icon system.
const REACTION_BUTTONS = [
  { type: 'like', icon: '▲', label: 'Like' },
  { type: 'dislike', icon: '▼', label: 'Dislike' },
  { type: 'question', icon: '?', label: 'Question' }
];

// Threaded comments UI for a single polymorphic target:
//   { kpi_id } | { memo_id } | { analysis_id }
// Features: list (persists via API), post, reply (parent_id), resolve/unresolve,
// soft-delete (author or admin), bold @mention rendering, per-user reactions.
// No email/push.
export default function CommentThread({ target, title = 'Comments' }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState(null); // comment id or null
  const [busy, setBusy] = useState(false);
  // comment ids with an in-flight reaction request (prevent double-submit)
  const [reactingIds, setReactingIds] = useState(() => new Set());
  // comment id awaiting delete confirmation (inline confirm step)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const { userId, capabilities } = useRole();
  const canDeleteAny =
    Array.isArray(capabilities) && capabilities.includes('delete_any_comment');

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

  // Soft-delete after inline confirmation. Removes the comment from local
  // list immediately so it no longer appears in the thread.
  async function onConfirmDelete(comment) {
    if (!comment || !comment.id || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteComment(comment.id);
      setConfirmDeleteId(null);
      setComments((list) => list.filter((c) => c.id !== comment.id));
      if (replyTo === comment.id) setReplyTo(null);
    } catch (err) {
      setError(
        err && err.status === 403
          ? 'You do not have permission to delete this comment.'
          : err && err.status === 401
            ? 'Sign in required to delete comments.'
            : 'Could not delete comment.'
      );
    }
    setBusy(false);
  }

  // Toggle / switch / set reaction with optimistic count + highlight update.
  async function onReact(comment, type) {
    if (!comment || !comment.id || reactingIds.has(comment.id)) return;
    const prev = {
      reaction_counts: {
        like: 0,
        dislike: 0,
        question: 0,
        ...(comment.reaction_counts || {})
      },
      my_reaction: comment.my_reaction || null
    };
    const optimistic = applyReactionLocally(comment, type);

    setReactingIds((s) => new Set(s).add(comment.id));
    setComments((list) =>
      list.map((c) =>
        c.id === comment.id
          ? {
              ...c,
              reaction_counts: optimistic.reaction_counts,
              my_reaction: optimistic.my_reaction
            }
          : c
      )
    );
    setError(null);

    try {
      const data = await setCommentReaction(comment.id, type);
      const server = data && data.comment;
      if (server) {
        setComments((list) =>
          list.map((c) =>
            c.id === comment.id
              ? {
                  ...c,
                  reaction_counts: server.reaction_counts || optimistic.reaction_counts,
                  my_reaction:
                    server.my_reaction !== undefined
                      ? server.my_reaction
                      : data.my_reaction !== undefined
                        ? data.my_reaction
                        : optimistic.my_reaction
                }
              : c
          )
        );
      }
    } catch (err) {
      // Roll back optimistic update on failure.
      setComments((list) =>
        list.map((c) =>
          c.id === comment.id
            ? {
                ...c,
                reaction_counts: prev.reaction_counts,
                my_reaction: prev.my_reaction
              }
            : c
        )
      );
      setError(
        err && (err.status === 401 || err.status === 403)
          ? 'Sign in required to react.'
          : 'Could not update reaction.'
      );
    }

    setReactingIds((s) => {
      const next = new Set(s);
      next.delete(comment.id);
      return next;
    });
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
            viewerUserId={userId}
            canDeleteAny={canDeleteAny}
            confirmDeleteId={confirmDeleteId}
            onReply={(id) => setReplyTo(id)}
            onToggleResolve={onToggleResolve}
            onReact={onReact}
            onRequestDelete={(id) => setConfirmDeleteId(id)}
            onCancelDelete={() => setConfirmDeleteId(null)}
            onConfirmDelete={onConfirmDelete}
            reacting={reactingIds.has(c.id)}
            reactingIds={reactingIds}
            busy={busy}
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

function canViewerDeleteComment(comment, viewerUserId, canDeleteAny) {
  if (!comment) return false;
  if (canDeleteAny) return true;
  if (
    viewerUserId != null &&
    comment.author_id != null &&
    String(comment.author_id) === String(viewerUserId)
  ) {
    return true;
  }
  return false;
}

function CommentItem({
  comment,
  depth,
  viewerUserId,
  canDeleteAny,
  confirmDeleteId,
  onReply,
  onToggleResolve,
  onReact,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  reacting,
  reactingIds,
  busy
}) {
  const isReply = depth > 0;
  const counts = {
    like: 0,
    dislike: 0,
    question: 0,
    ...(comment.reaction_counts || {})
  };
  const myReaction = comment.my_reaction || null;
  const isReacting = reacting || (reactingIds && reactingIds.has(comment.id));
  const showDelete = canViewerDeleteComment(comment, viewerUserId, canDeleteAny);
  const confirming = confirmDeleteId === comment.id;

  return (
    <li
      className={`comment-item${comment.resolved ? ' comment-item--resolved' : ''}${
        isReply ? ' comment-item--reply' : ''
      }`}
      data-testid="comment-item"
      data-comment-id={comment.id}
      data-parent-id={comment.parent_id || ''}
      data-resolved={comment.resolved ? 'true' : 'false'}
      data-my-reaction={myReaction || ''}
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
      <div
        className="comment-item__reactions"
        data-testid="comment-reactions"
        role="group"
        aria-label="Reactions"
      >
        {REACTION_BUTTONS.map(({ type, icon, label }) => {
          const active = myReaction === type;
          const count = counts[type] || 0;
          return (
            <button
              key={type}
              type="button"
              className={`comment-reaction${
                active ? ' comment-reaction--active' : ''
              }`}
              data-testid={`comment-reaction-${type}`}
              data-reaction={type}
              data-active={active ? 'true' : 'false'}
              data-count={count}
              aria-label={`${label}${active ? ' (your reaction)' : ''}`}
              aria-pressed={active}
              disabled={isReacting}
              onClick={() => onReact(comment, type)}
            >
              <span className="comment-reaction__icon" aria-hidden="true">
                {icon}
              </span>
              <span
                className="comment-reaction__count"
                data-testid={`comment-reaction-${type}-count`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>
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
        {showDelete ? (
          confirming ? (
            <span
              className="comment-item__confirm"
              data-testid="comment-delete-confirm"
            >
              <span className="comment-item__confirm-label">Delete this comment?</span>
              <button
                type="button"
                className="comment-item__btn comment-item__btn--danger"
                data-testid="comment-delete-confirm-btn"
                disabled={busy}
                onClick={() => onConfirmDelete(comment)}
              >
                Confirm delete
              </button>
              <button
                type="button"
                className="comment-item__btn"
                data-testid="comment-delete-cancel-btn"
                disabled={busy}
                onClick={onCancelDelete}
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="comment-item__btn comment-item__btn--danger"
              data-testid="comment-delete-btn"
              disabled={busy}
              onClick={() => onRequestDelete(comment.id)}
            >
              Delete
            </button>
          )
        ) : null}
      </div>
      {comment.replies && comment.replies.length > 0 ? (
        <ul className="comment-list comment-list--nested">
          {comment.replies.map((r) => (
            <CommentItem
              key={r.id}
              comment={r}
              depth={depth + 1}
              viewerUserId={viewerUserId}
              canDeleteAny={canDeleteAny}
              confirmDeleteId={confirmDeleteId}
              onReply={onReply}
              onToggleResolve={onToggleResolve}
              onReact={onReact}
              onRequestDelete={onRequestDelete}
              onCancelDelete={onCancelDelete}
              onConfirmDelete={onConfirmDelete}
              reacting={reactingIds && reactingIds.has(r.id)}
              reactingIds={reactingIds}
              busy={busy}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
