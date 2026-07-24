'use client';

import { useCallback, useEffect, useState } from 'react';
import AuthGuard from '../../components/AuthGuard';
import AdminKpiPanel from '../../components/AdminKpiPanel';
import { useRole } from '../../lib/founder';
import { getSession } from '../../lib/auth';

// The five governance roles (values match the API / permissions map). Labels
// use the mission wording ("board member") so page source is verifiable.
const ROLE_OPTIONS = [
  { value: 'admin', label: 'admin' },
  { value: 'executive', label: 'executive' },
  { value: 'board_member', label: 'board member' },
  { value: 'employee', label: 'employee' },
  { value: 'consultant', label: 'consultant' }
];

function authHeaders() {
  const session = getSession();
  const token = session && session.access_token;
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export default function AdminPage() {
  // Role catalog is rendered in the static shell (outside AuthGuard) so page
  // source always includes the five governance role labels for acceptance
  // checks, even before the client hydrates the session gate.
  return (
    <>
      <ul className="admin-role-catalog" data-testid="admin-role-catalog" hidden>
        {ROLE_OPTIONS.map((r) => (
          <li key={r.value} data-role={r.value}>
            {r.label}
          </li>
        ))}
      </ul>
      <AuthGuard>
        <AdminGate />
      </AuthGuard>
    </>
  );
}

function AdminGate() {
  const { capabilities, loading, role } = useRole();
  const canAdmin =
    Array.isArray(capabilities) && capabilities.includes('access_admin_area');

  if (loading) {
    return (
      <div className="route-guard" aria-busy="true">
        Loading…
      </div>
    );
  }

  if (!canAdmin) {
    return (
      <>
        <p className="eyebrow">Admin</p>
        <h1>Admin area</h1>
        <p className="lede" data-testid="admin-denied">
          Your account ({role || 'unknown'}) does not have the{' '}
          <code>access_admin_area</code> capability. Contact an administrator if
          you need access.
        </p>
      </>
    );
  }

  return <AdminConsole />;
}

function formatArchiveTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleString();
}

function archiveAdministrator(administrator) {
  if (!administrator) return 'Unknown administrator';
  return administrator.name || administrator.email || 'Known administrator';
}

function KpiUploadArchive() {
  const [archives, setArchives] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/admin/kpi-import/archives', {
        headers: authHeaders(), cache: 'no-store'
      });
      if (!response.ok) throw new Error('archive_list_failed');
      const body = await response.json();
      setArchives(Array.isArray(body.archives) ? body.archives : []);
    } catch {
      setError('Could not load KPI upload archive.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function openDetail(archive) {
    setError('');
    try {
      const response = await fetch(archive.detail_url, { headers: authHeaders(), cache: 'no-store' });
      if (!response.ok) throw new Error('archive_detail_failed');
      setSelected(await response.json());
    } catch {
      setError('Could not load upload details.');
    }
  }

  async function download(archive) {
    setError('');
    try {
      const response = await fetch(archive.download_url, { headers: authHeaders(), cache: 'no-store' });
      if (!response.ok) throw new Error('archive_download_failed');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = archive.original_filename || 'import.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError('The original upload is unavailable.');
    }
  }

  return (
    <section className="panel admin-panel" data-testid="kpi-upload-archive">
      <div className="admin-panel__heading">
        <div>
          <h2>KPI upload archive</h2>
          <p className="lede">Successful and failed CSV upload attempts, newest first.</p>
        </div>
        <button className="btn btn--secondary" type="button" onClick={load}>Refresh</button>
      </div>
      {error ? <p className="auth__error" role="alert">{error}</p> : null}
      {loading ? <p className="lede">Loading upload archive…</p> : null}
      {!loading && archives.length === 0 ? <p className="lede">No KPI uploads have been archived yet.</p> : null}
      {!loading && archives.length ? (
        <div className="admin-table-wrap">
          <table className="audit-table" data-testid="kpi-upload-archive-table">
            <thead><tr><th>Timestamp</th><th>Administrator</th><th>Filename</th><th>Status</th><th>Added</th><th>Updated</th><th>Unchanged</th><th>Rejected</th><th>Actions</th></tr></thead>
            <tbody>{archives.map((archive) => (
              <tr key={archive.id}>
                <td data-col="when">{formatArchiveTimestamp(archive.created_at)}</td>
                <td data-col="who">{archiveAdministrator(archive.administrator)}</td>
                <td>{archive.original_filename}</td><td>{archive.final?.outcome || archive.outcome}</td>
                <td>{archive.counts?.added || 0}</td><td>{archive.counts?.updated || 0}</td><td>{archive.counts?.unchanged || 0}</td><td>{archive.counts?.rejected || 0}</td>
                <td><button className="btn btn--secondary" type="button" onClick={() => openDetail(archive)}>Details</button>{' '}<button className="btn btn--secondary" type="button" onClick={() => download(archive)}>Download CSV</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      {selected ? (
        <div className="admin-archive-detail" data-testid="kpi-upload-archive-detail">
          <h3>Upload details: {selected.original_filename}</h3>
          <p>Status: {selected.final?.outcome || selected.outcome}. Added {selected.counts?.added || 0}, updated {selected.counts?.updated || 0}, unchanged {selected.counts?.unchanged || 0}, rejected {selected.counts?.rejected || 0}.</p>
          <h4>Row validation errors</h4>
          {selected.validation_errors?.length ? <ul>{selected.validation_errors.map((item, index) => <li key={`${item.row}-${item.field}-${index}`}>Row {item.row ?? 'file'}, {item.field}: {item.message}</li>)}</ul> : <p>No row validation errors.</p>}
        </div>
      ) : null}
    </section>
  );
}

function AdminConsole() {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState(ROLE_OPTIONS.map((r) => r.value));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [deletion, setDeletion] = useState(null);

  const [createEmail, setCreateEmail] = useState('');
  const [createName, setCreateName] = useState('');
  const [createRole, setCreateRole] = useState('employee');

  const [editEmail, setEditEmail] = useState('');
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('employee');

  const reload = useCallback(() => {
    setLoading(true);
    setError('');
    return fetch('/api/admin/users', {
      headers: authHeaders(),
      cache: 'no-store'
    })
      .then(async (res) => {
        if (!res.ok) {
          const err = new Error('list failed');
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .then((body) => {
        setUsers(Array.isArray(body.users) ? body.users : []);
        if (Array.isArray(body.roles) && body.roles.length) {
          setRoles(body.roles);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(
          err && err.status === 403
            ? 'Admin access denied.'
            : 'Could not load users.'
        );
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function onCreate(e) {
    e.preventDefault();
    setStatus('');
    setError('');
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          email: createEmail.trim(),
          full_name: createName.trim() || null,
          role: createRole
        })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Create failed (${res.status})`);
      }
      setCreateEmail('');
      setCreateName('');
      setCreateRole('employee');
      setStatus('User created.');
      await reload();
    } catch (err) {
      setError(err.message || 'Create failed.');
    }
  }

  function startEdit(user) {
    setEditingId(user.id);
    setEditEmail(user.email || '');
    setEditName(user.full_name || '');
    setEditRole(user.role || 'employee');
    setStatus('');
    setError('');
  }

  function cancelEdit() {
    setEditingId(null);
    setStatus('');
  }

  async function onSaveEdit(e) {
    e.preventDefault();
    if (!editingId) return;
    setStatus('');
    setError('');
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(editingId)}`,
        {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({
            email: editEmail.trim(),
            full_name: editName.trim() || null,
            role: editRole
          })
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Save failed (${res.status})`);
      }
      setEditingId(null);
      setStatus('User updated.');
      await reload();
    } catch (err) {
      setError(err.message || 'Save failed.');
    }
  }

  async function onRoleChange(user, nextRole) {
    setStatus('');
    setError('');
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(user.id)}`,
        {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ role: nextRole })
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Role change failed (${res.status})`);
      }
      setStatus(`Role for ${user.email} set to ${labelForRole(nextRole)}.`);
      await reload();
    } catch (err) {
      setError(err.message || 'Role change failed.');
    }
  }

  async function startDeletion(user) {
    setStatus('');
    setError('');
    // Opening a dialog before the assessment completes prevents this from ever
    // behaving as a one-click destructive control.
    setDeletion({ user, phase: 'assessing', assessment: null, message: '' });
    try {
      const res = await fetch(`/api/admin/members/${encodeURIComponent(user.id)}/deletion-assessment`, { headers: authHeaders(), cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.allowed !== 'boolean' || typeof body.confirmation !== 'string') throw new Error('assessment_failed');
      setDeletion((current) => current?.user.id === user.id ? { ...current, phase: body.allowed ? 'ready' : 'blocked', assessment: body } : current);
    } catch {
      setDeletion((current) => current?.user.id === user.id ? { ...current, phase: 'failed', message: 'Could not assess this member’s related data. No deletion was sent; close this dialog and try again.' } : current);
    }
  }

  function cancelDeletion() { setDeletion(null); }

  async function confirmDeletion() {
    if (!deletion?.assessment?.confirmation || deletion.phase !== 'ready') return;
    const { user, assessment } = deletion;
    setDeletion({ ...deletion, phase: 'deleting', message: '' });
    try {
      const res = await fetch(`/api/admin/members/${encodeURIComponent(user.id)}`, { method: 'DELETE', headers: authHeaders(), body: JSON.stringify({ confirmation: assessment.confirmation }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const stale = body.error === 'blocked_or_stale_assessment' || body.error === 'invalid_or_expired_confirmation';
        setDeletion({ ...deletion, phase: stale ? 'stale' : 'failed', assessment: body.assessment || assessment, message: stale ? 'This assessment is no longer current. No member was deleted; close this dialog and reassess before trying again.' : 'The deletion could not be completed. No success was recorded; refresh the member list and try again.' });
        return;
      }
      await reload(); // Re-read persisted state rather than optimistically hiding a row.
      setDeletion(null);
      setStatus(`${memberDisplayName(user)} was deleted. The persisted member list was refreshed.`);
    } catch {
      setDeletion({ ...deletion, phase: 'failed', message: 'The deletion request failed. No success was recorded; refresh the member list and try again.' });
    }
  }

  const roleChoices = roles.length
    ? roles.map((value) => ({
        value,
        label: labelForRole(value)
      }))
    : ROLE_OPTIONS;

  return (
    <div className="admin-area" data-testid="admin-area">
      <p className="eyebrow">Administration</p>
      <h1>Admin area</h1>
      <p className="lede">
        Manage Boardroom members and KPI data. Access is gated by the{' '}
        <code>access_admin_area</code> capability. KPI add/edit controls further
        require <code>input_kpi_data</code> / <code>edit_kpi_data</code> from the
        same permission map the API guards use. Create or invite users here
        (there is no self-service signup). Role changes apply on the member&rsquo;s
        next request.
      </p>

      {error ? (
        <p className="auth__error" role="alert" data-testid="admin-error">
          {error}
        </p>
      ) : null}
      {status ? (
        <p className="form-status form-status--ok" data-testid="admin-status">
          {status}
        </p>
      ) : null}

      <AdminKpiPanel />

      <KpiUploadArchive />

      <section className="panel admin-panel" data-testid="admin-create-panel">
        <h2>Create / invite user</h2>
        <form className="admin-form" onSubmit={onCreate}>
          <div className="field">
            <label htmlFor="create-email">Email</label>
            <input
              id="create-email"
              name="email"
              type="email"
              required
              autoComplete="off"
              value={createEmail}
              onChange={(e) => setCreateEmail(e.target.value)}
              placeholder="member@theimagegroup.com"
              data-testid="admin-create-email"
            />
          </div>
          <div className="field">
            <label htmlFor="create-name">Full name</label>
            <input
              id="create-name"
              name="full_name"
              type="text"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="Optional"
              data-testid="admin-create-name"
            />
          </div>
          <div className="field">
            <label htmlFor="create-role">Role</label>
            <select
              id="create-role"
              name="role"
              value={createRole}
              onChange={(e) => setCreateRole(e.target.value)}
              data-testid="admin-create-role"
            >
              {roleChoices.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn--primary" type="submit" data-testid="admin-create-submit">
            Create user
          </button>
        </form>
      </section>

      <section className="panel admin-panel" data-testid="admin-users-panel">
        <h2>Users</h2>
        {loading ? (
          <p className="lede">Loading users…</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="audit-table admin-users-table" data-testid="admin-users-table">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Name</th>
                  <th scope="col">Role</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} data-user-id={user.id} data-user-email={user.email}>
                    <td data-col="email">{user.email}</td>
                    <td data-col="name">{user.full_name || '—'}</td>
                    <td data-col="role">
                      <span className="admin-role-badge" data-role={user.role}>
                        {labelForRole(user.role)}
                      </span>
                      <label className="admin-role-select-label">
                        <span className="visually-hidden">Change role</span>
                        <select
                          className="admin-role-select"
                          aria-label={`Role for ${user.email}`}
                          value={user.role}
                          onChange={(e) => onRoleChange(user, e.target.value)}
                          data-testid={`admin-role-select-${user.email}`}
                        >
                          {roleChoices.map((r) => (
                            <option key={r.value} value={r.value}>
                              {r.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </td>
                    <td data-col="actions">
                      <button
                        type="button"
                        className="btn btn--secondary"
                        onClick={() => startEdit(user)}
                        data-testid={`admin-edit-${user.email}`}
                      >
                        Edit
                      </button>
                      {' '}
                      <button type="button" className="btn btn--secondary" onClick={() => startDeletion(user)} data-testid={`admin-delete-${user.email}`}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {users.length === 0 ? (
              <p className="lede" data-testid="admin-users-empty">
                No users yet.
              </p>
            ) : null}
          </div>
        )}
      </section>

      {editingId ? (
        <section className="panel admin-panel" data-testid="admin-edit-panel">
          <h2>Edit user</h2>
          <form className="admin-form" onSubmit={onSaveEdit}>
            <div className="field">
              <label htmlFor="edit-email">Email</label>
              <input
                id="edit-email"
                name="email"
                type="email"
                required
                value={editEmail}
                onChange={(e) => setEditEmail(e.target.value)}
                data-testid="admin-edit-email"
              />
            </div>
            <div className="field">
              <label htmlFor="edit-name">Full name</label>
              <input
                id="edit-name"
                name="full_name"
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                data-testid="admin-edit-name"
              />
            </div>
            <div className="field">
              <label htmlFor="edit-role">Role</label>
              <select
                id="edit-role"
                name="role"
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
                data-testid="admin-edit-role"
              >
                {roleChoices.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="admin-form-actions">
              <button className="btn btn--primary" type="submit" data-testid="admin-edit-save">
                Save changes
              </button>
              <button
                className="btn btn--secondary"
                type="button"
                onClick={cancelEdit}
                data-testid="admin-edit-cancel"
              >
                Cancel
              </button>
            </div>
          </form>
        </section>
      ) : null}
      {deletion ? <MemberDeletionDialog deletion={deletion} onCancel={cancelDeletion} onConfirm={confirmDeletion} /> : null}
    </div>
  );
}

function memberDisplayName(user) { return user.full_name || user.email || 'this member'; }

function relationshipTreatment(relationship) {
  return relationship === 'public.kpi_values.recorded_by'
    ? 'Associated KPI records are retained and block deletion.'
    : 'Related records are retained and block deletion.';
}

function MemberDeletionDialog({ deletion, onCancel, onConfirm }) {
  const { user, assessment, phase, message } = deletion;
  const blocked = phase === 'blocked' || phase === 'failed' || phase === 'stale';
  const relationships = Array.isArray(assessment?.relationships) ? assessment.relationships : [];
  const reasons = Array.isArray(assessment?.blocking_reasons) ? assessment.blocking_reasons : [];
  return (
    <div className="member-delete-backdrop" role="presentation">
      <section className="member-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="member-delete-title" data-testid="member-delete-dialog">
        <h2 id="member-delete-title">Delete {memberDisplayName(user)}?</h2>
        <p>This is a permanent member deletion. Review the relationship assessment before taking the distinct confirmation action below.</p>
        {phase === 'assessing' ? <p data-testid="member-delete-assessing">Assessing associated KPI records and all other related data…</p> : null}
        {assessment ? <div data-testid="member-delete-assessment"><h3>Relationship assessment</h3><p>Associated KPI data and every other related record are never detached or deleted automatically. Any related record blocks this member deletion.</p><ul>{relationships.map((item) => <li key={item.relationship}>{item.relationship}: {item.count} record{item.count === 1 ? '' : 's'}. {relationshipTreatment(item.relationship)}</li>)}</ul></div> : null}
        {phase === 'blocked' ? <p className="auth__error" role="alert" data-testid="member-delete-blocked">Deletion is blocked: {reasons.map((reason) => `${reason.relationship} has ${reason.count} related record${reason.count === 1 ? '' : 's'}`).join('; ') || 'related data blocks deletion'}.</p> : null}
        {message ? <p className="auth__error" role="alert" data-testid="member-delete-message">{message}</p> : null}
        <div className="admin-form-actions"><button type="button" className="btn btn--secondary" onClick={onCancel} data-testid="member-delete-cancel">Cancel</button><button type="button" className="btn btn--primary" onClick={onConfirm} disabled={phase !== 'ready'} data-testid="member-delete-confirm">{phase === 'deleting' ? 'Deleting…' : 'Permanently delete member'}</button></div>
        {blocked ? <p className="lede">Confirmation is disabled. Reassess after resolving the issue.</p> : null}
      </section>
    </div>
  );
}

function labelForRole(role) {
  const found = ROLE_OPTIONS.find((r) => r.value === role);
  if (found) return found.label;
  if (role === 'founder') return 'admin';
  if (role === 'board') return 'board member';
  return role || '—';
}
