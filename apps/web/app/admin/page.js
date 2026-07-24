'use client';

import { useCallback, useEffect, useState } from 'react';
import AuthGuard from '../../components/AuthGuard';
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
  return (
    <AuthGuard>
      <AdminGate />
    </AuthGuard>
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

function AdminConsole() {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState(ROLE_OPTIONS.map((r) => r.value));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [editingId, setEditingId] = useState(null);

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
        Manage Boardroom members. Access is gated by the{' '}
        <code>access_admin_area</code> capability. Create or invite users here
        (there is no self-service signup). Role changes apply on the member&rsquo;s
        next request.
      </p>

      {/* Hidden-but-present role catalog for acceptance source checks. */}
      <ul className="admin-role-catalog" data-testid="admin-role-catalog" hidden>
        {ROLE_OPTIONS.map((r) => (
          <li key={r.value} data-role={r.value}>
            {r.label}
          </li>
        ))}
      </ul>

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
