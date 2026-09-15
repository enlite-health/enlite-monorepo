import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { AdminUser } from '@domain/entities/AdminUser';
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
import { CreateAdminUserModal, CreateAdminUserForm } from '@presentation/components/admin/CreateAdminUserModal';
import { DeleteAdminUserModal } from '@presentation/components/admin/DeleteAdminUserModal';
import { InvitationFallbackModal } from '@presentation/components/admin/InvitationFallbackModal';

// ── Page ───────────────────────────────────────────────────────────────────

export function AdminUsersPage(): JSX.Element {
  const { t } = useTranslation();
  // POST /users/:id/reset-password e DELETE /users/:id → user_management:write e
  // user_management:delete respectivamente — botões raw `<button>` (não `<Button>`),
  // então o gate é `useActionGate` direto, mesma régua do `ActionButton` (D269).
  const resetGate = useActionGate('user_management', 'update');
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
        {/* POST /users → user_management:create (D269, PR-8b) — a célula é o único freio. */}
        <ActionButton
          resource="user_management"
          action="create"
          variant="primary"
          onClick={() => setShowCreateModal(true)}
        >
          {t('admin.users.create')}
        </ActionButton>
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
              <TableHead>{t('admin.users.lastLogin')}</TableHead>
              <TableHead align="right">{t('admin.users.actions')}</TableHead>
            </TableHeader>
            <TableBody>
              {admins.map((admin) => (
                <TableRow key={admin.firebaseUid}>
                  <TableCell weight="medium">{admin.displayName || '—'}</TableCell>
                  <TableCell>{admin.email}</TableCell>
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
                    {deleteGate.allowed && (
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
                  <TableCell unwrapped colSpan={4} className="px-6 py-8 text-center">
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
