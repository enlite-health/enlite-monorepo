import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { AdminUser } from '@domain/entities/AdminUser';
import { EnliteRole } from '@domain/entities/EnliteRole';
import {
  Heading,
  Text,
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { CreateAdminUserModal, CreateAdminUserForm } from '@presentation/components/admin/CreateAdminUserModal';
import { DeleteAdminUserModal } from '@presentation/components/admin/DeleteAdminUserModal';
import { InvitationFallbackModal } from '@presentation/components/admin/InvitationFallbackModal';

// ── Role badge ─────────────────────────────────────────────────────────────

const ROLE_BADGE_CLASSES: Record<EnliteRole, string> = {
  [EnliteRole.ADMIN]:             'bg-purple-100 text-purple-800',
  [EnliteRole.RECRUITER]:         'bg-blue-100 text-blue-800',
  [EnliteRole.COMMUNITY_MANAGER]: 'bg-green-100 text-green-800',
};

function RoleBadge({ role }: { role: EnliteRole }): JSX.Element {
  const { t } = useTranslation();
  const labelKey = {
    [EnliteRole.ADMIN]:             'admin.users.roleAdmin',
    [EnliteRole.RECRUITER]:         'admin.users.roleRecruiter',
    [EnliteRole.COMMUNITY_MANAGER]: 'admin.users.roleCommunityManager',
  }[role];

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded ${ROLE_BADGE_CLASSES[role]}`}>
      <Text as="span" size="xs" weight="medium" color="inherit">
        {t(labelKey)}
      </Text>
    </span>
  );
}

// ── Inline role selector (admin-only) ──────────────────────────────────────

interface RoleCellProps {
  admin: AdminUser;
  canEdit: boolean;
  onRoleChange: (uid: string, role: EnliteRole) => Promise<void>;
}

function RoleCell({ admin, canEdit, onRoleChange }: RoleCellProps): JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  // PATCH /users/:id/role → permission_management:write (não user_management:write —
  // mexer no papel de alguém é mexer em ACESSO). `<select>` não é `<Button>`:
  // useActionGate direto, mesma régua do ActionButton (D269).
  const { allowed: canWriteRole } = useActionGate('permission_management', 'write');

  if (!canEdit || !canWriteRole) return <RoleBadge role={admin.role} />;

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as EnliteRole;
    setBusy(true);
    try {
      await onRoleChange(admin.firebaseUid, next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <select
      className="text-xs border border-gray-300 rounded px-2 py-1 focus:ring-2 focus:ring-primary focus:border-primary disabled:opacity-50"
      value={admin.role}
      onChange={handleChange}
      disabled={busy}
      aria-label={t('admin.users.role')}
    >
      <option value={EnliteRole.ADMIN}>{t('admin.users.roleAdmin')}</option>
      <option value={EnliteRole.RECRUITER}>{t('admin.users.roleRecruiter')}</option>
      <option value={EnliteRole.COMMUNITY_MANAGER}>{t('admin.users.roleCommunityManager')}</option>
    </select>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export function AdminUsersPage(): JSX.Element {
  const { t } = useTranslation();
  const { adminProfile } = useAdminAuth();
  const isAdmin = adminProfile?.role === EnliteRole.ADMIN;
  // POST /users/:id/reset-password e DELETE /users/:id → ambas user_management:write
  // e user_management:delete respectivamente — botões raw `<button>` (não `<Button>`),
  // então o gate é `useActionGate` direto (mesmo padrão do `<select>` de papel acima).
  const resetGate = useActionGate('user_management', 'write');
  const deleteGate = useActionGate('user_management', 'delete');

  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modals
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminUser | null>(null);
  const [fallback, setFallback] = useState<{ email: string; resetLink: string; mode: 'create' | 'reset' } | null>(null);

  const loadAdmins = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await AdminApiService.listAdmins();
      setAdmins(data.admins);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadAdmins(); }, [loadAdmins]);

  const handleCreate = async (form: CreateAdminUserForm) => {
    setCreating(true);
    try {
      const result = await AdminApiService.createAdmin({
        email: form.email,
        displayName: form.displayName,
        role: form.role,
      });
      setShowCreateModal(false);
      await loadAdmins();
      setFallback({
        email: result.email,
        resetLink: result.resetLink ?? '',
        mode: 'create',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (firebaseUid: string, role: EnliteRole) => {
    try {
      await AdminApiService.updateAdminRole(firebaseUid, role);
      await loadAdmins();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.users.errorUpdateRole'));
    }
  };

  const handleDelete = async (admin: AdminUser) => {
    try {
      await AdminApiService.deleteAdmin(admin.firebaseUid);
      setDeleteTarget(null);
      await loadAdmins();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    }
  };

  const handleResetPassword = async (admin: AdminUser) => {
    try {
      const result = await AdminApiService.resetPassword(admin.firebaseUid);
      setFallback({
        email: admin.email,
        resetLink: result.resetLink,
        mode: 'reset',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.users.errorResetPassword'));
    }
  };

  return (
    <div className="space-y-6">
      {/* data-testid estável para screenshot de e2e — a lista abaixo cresce
          conforme outros specs @integration inserem contas de teste. */}
      <div className="flex items-center justify-between" data-testid="admin-users-header">
        <Heading level={1} weight="semibold" color="primary">
          {t('admin.users.title')}
        </Heading>
        {isAdmin && (
          // POST /users → user_management:write (D269).
          <ActionButton
            resource="user_management"
            action="write"
            variant="primary"
            onClick={() => setShowCreateModal(true)}
          >
            {t('admin.users.create')}
          </ActionButton>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 px-4 py-3 rounded-lg flex items-center justify-between">
          <Text size="sm" color="primary">{error}</Text>
          <button className="ml-2 text-red-600 hover:text-red-800" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {isLoading ? (
        <TableSkeleton />
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-400">
          <Table>
            <TableHeader>
              <TableHead>{t('admin.users.name')}</TableHead>
              <TableHead>{t('admin.users.email')}</TableHead>
              <TableHead>{t('admin.users.role')}</TableHead>
              <TableHead>{t('admin.users.lastLogin')}</TableHead>
              <TableHead align="right">{t('admin.users.actions')}</TableHead>
            </TableHeader>
            <TableBody>
              {admins.map((admin) => (
                <TableRow key={admin.firebaseUid}>
                  <TableCell weight="medium">{admin.displayName || '—'}</TableCell>
                  <TableCell>{admin.email}</TableCell>
                  <TableCell unwrapped>
                    <RoleCell admin={admin} canEdit={isAdmin} onRoleChange={handleRoleChange} />
                  </TableCell>
                  <TableCell>
                    {admin.lastLoginAt
                      ? new Date(admin.lastLoginAt).toLocaleDateString('es-AR')
                      : '—'}
                  </TableCell>
                  <TableCell unwrapped align="right" className="space-x-2">
                    {resetGate.allowed && (
                      <button
                        type="button"
                        className="text-blue-600 hover:underline"
                        onClick={() => handleResetPassword(admin)}
                      >
                        <Text as="span" size="xs" color="inherit">{t('admin.users.reset')}</Text>
                      </button>
                    )}
                    {isAdmin && deleteGate.allowed && (
                      <button
                        type="button"
                        className="text-red-600 hover:underline"
                        onClick={() => setDeleteTarget(admin)}
                      >
                        <Text as="span" size="xs" color="inherit">{t('admin.users.delete')}</Text>
                      </button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {admins.length === 0 && (
                <TableRow>
                  <TableCell unwrapped colSpan={5} className="px-6 py-8 text-center">
                    <Text as="span" size="sm" color="secondary">{t('admin.users.empty')}</Text>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {showCreateModal && (
        <CreateAdminUserModal
          isLoading={creating}
          onSubmit={handleCreate}
          onClose={() => setShowCreateModal(false)}
        />
      )}

      {deleteTarget && (
        <DeleteAdminUserModal
          target={deleteTarget}
          onConfirm={() => handleDelete(deleteTarget)}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {fallback && (
        <InvitationFallbackModal
          email={fallback.email}
          resetLink={fallback.resetLink}
          mode={fallback.mode}
          onClose={() => setFallback(null)}
        />
      )}
    </div>
  );
}
