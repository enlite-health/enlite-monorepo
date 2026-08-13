/**
 * PatientChatRolesPage — administração do CATÁLOGO de papéis de grupo de
 * WhatsApp do paciente (`patient_chat_roles`, migration 262). SÓ ADMIN.
 *
 * POR QUE ESTA TELA EXISTE. Os papéis eram uma lista em código. Em um único dia
 * o Marcel foi de 2 ("sempre um família e um prestador", call de 05/08) para 3
 * (áudio: plano de saúde), com um quarto citado solto ("ou de gestão"); e a
 * planilha dele trouxe 27 pagadores distintos. Papel em código = migration +
 * deploy toda vez que a operação muda de ideia, e ela está mudando toda semana.
 *
 * A tela mostra a CONTAGEM DE USO ao lado de cada papel de propósito: as duas
 * operações perigosas (desativar/apagar papel em uso, e virar um papel de
 * compartilhado para exclusivo) são recusadas pelo backend COM número, e quem
 * opera precisa ver esse número antes de tentar, não depois de levar o erro.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MessagesSquare, Edit2, Trash2, Plus, Lock, Unlock } from 'lucide-react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuth } from '@presentation/hooks/useAdminAuth';
import { EnliteRole } from '@domain/entities/EnliteRole';
import type { PatientChatRoleSpec } from '@domain/value-objects/patientChatRole';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@presentation/components/atoms/Table';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import {
  PatientChatRoleFormModal,
  type ChatRoleFormData,
} from './PatientChatRolesPage/PatientChatRoleFormModal';
import { refusalMessage } from './PatientChatRolesPage/refusalMessage';

export default function PatientChatRolesPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { adminProfile } = useAdminAuth();
  const tr = (k: string, o?: Record<string, unknown>) => t(`admin.patientChatRoles.${k}`, o ?? {});

  // Mesma trava de rota do TagCatalogPage. É defesa em profundidade, não a
  // trava real: quem manda é o `requireAdmin()` do backend (403), que uma
  // chamada direta à API não contorna.
  useEffect(() => {
    if (adminProfile && adminProfile.role !== EnliteRole.ADMIN) {
      navigate('/admin', { replace: true });
    }
  }, [adminProfile, navigate]);

  const [roles, setRoles] = useState<PatientChatRoleSpec[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Recusa do backend (409 com contagem) exibida no topo da lista. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [formModal, setFormModal] = useState<{ open: boolean; role: PatientChatRoleSpec | null }>({
    open: false,
    role: null,
  });

  const fetchRoles = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      // includeInactive: a administração precisa ver o que está desligado E a
      // contagem de uso.
      const data = await AdminApiService.listPatientChatRoles(true);
      setRoles(data.roles);
      setUsage(data.usage ?? {});
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { fetchRoles(); }, [fetchRoles]);

  async function handleFormSave(data: ChatRoleFormData): Promise<void> {
    if (formModal.role) {
      const { code: _ignored, ...editable } = data;
      await AdminApiService.updatePatientChatRole(formModal.role.code, editable);
    } else {
      await AdminApiService.createPatientChatRole(data);
    }
    setFormModal({ open: false, role: null });
    setActionError(null);
    await fetchRoles();
  }

  /**
   * Desativar / reativar direto da linha. A recusa (409 CHAT_ROLE_IN_USE) vira
   * uma frase no idioma da tela, com a contagem que veio do servidor.
   */
  async function handleToggleActive(role: PatientChatRoleSpec): Promise<void> {
    try {
      setActionError(null);
      await AdminApiService.updatePatientChatRole(role.code, { isActive: !role.isActive });
      await fetchRoles();
    } catch (err: unknown) {
      setActionError(refusalMessage(err, t));
    }
  }

  async function handleDelete(role: PatientChatRoleSpec): Promise<void> {
    const count = usage[role.code] ?? 0;
    if (!window.confirm(tr('deleteConfirm', { code: role.code, count }))) return;
    try {
      setActionError(null);
      await AdminApiService.deletePatientChatRole(role.code);
      await fetchRoles();
    } catch (err: unknown) {
      setActionError(refusalMessage(err, t));
    }
  }

  return (
    <PageContainer>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <MessagesSquare className="w-6 h-6 text-primary" />
          <Heading level={1} weight="semibold" color="primary">{tr('title')}</Heading>
        </div>
        <Button
          variant="primary"
          size="md"
          onClick={() => setFormModal({ open: true, role: null })}
          data-testid="chat-role-new-btn"
        >
          <Plus className="w-4 h-4" />
          {tr('newRole')}
        </Button>
      </div>

      <Text size="sm" color="muted" className="mb-6">{tr('subtitle')}</Text>

      {actionError && (
        <div
          className="mb-4 border border-red-300 bg-red-50 rounded-lg px-4 py-3"
          role="alert"
          data-testid="chat-roles-action-error"
        >
          <Text size="sm" className="text-red-700">{actionError}</Text>
        </div>
      )}

      {loadError ? (
        <div className="py-12 text-center" data-testid="chat-roles-load-error">
          <Text color="inherit" className="text-red-600">{loadError}</Text>
        </div>
      ) : isLoading ? (
        <TableSkeleton />
      ) : roles.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center" data-testid="chat-roles-empty">
          <Text size="sm" color="muted">{tr('noRoles')}</Text>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-x-auto" data-testid="chat-roles-table">
          <Table>
            <TableHeader>
              <TableHead>{tr('table.code')}</TableHead>
              <TableHead>{tr('table.labels')}</TableHead>
              <TableHead>{tr('table.exclusive')}</TableHead>
              <TableHead>{tr('table.usage')}</TableHead>
              <TableHead>{tr('table.status')}</TableHead>
              <TableHead align="right">{tr('table.actions')}</TableHead>
            </TableHeader>
            <TableBody>
              {roles.map(role => {
                const count = usage[role.code] ?? 0;
                return (
                  <TableRow key={role.code} clickable={false} data-testid={`chat-role-row-${role.code}`}>
                    <TableCell unwrapped>
                      <Text as="span" size="sm" weight="medium" className="font-mono">{role.code}</Text>
                    </TableCell>
                    <TableCell unwrapped>
                      <div className="flex flex-col">
                        <Text as="span" size="sm">{role.labelEs}</Text>
                        <Text as="span" size="xs" color="muted">{role.labelPtBr}</Text>
                      </div>
                    </TableCell>
                    <TableCell unwrapped>
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                          role.isExclusive ? 'bg-slate-100 text-slate-700' : 'bg-amber-50 text-amber-800'
                        }`}
                        data-testid={`chat-role-exclusive-${role.code}`}
                      >
                        {role.isExclusive ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                        {role.isExclusive ? tr('exclusiveYes') : tr('exclusiveNo')}
                      </span>
                    </TableCell>
                    <TableCell unwrapped>
                      {/* O número que a pessoa precisa ver ANTES de mexer. */}
                      <span data-testid={`chat-role-usage-${role.code}`}>
                        <Text as="span" size="sm" color={count > 0 ? 'primary' : 'muted'}>
                          {tr('usageCount', { count })}
                        </Text>
                      </span>
                    </TableCell>
                    <TableCell unwrapped>
                      <span
                        className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${
                          role.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'
                        }`}
                        data-testid={`chat-role-status-${role.code}`}
                      >
                        {role.isActive ? tr('active') : tr('inactive')}
                      </span>
                    </TableCell>
                    <TableCell align="right" unwrapped>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setFormModal({ open: true, role })}
                          className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-primary transition-colors cursor-pointer"
                          aria-label={tr('editRole')}
                          data-testid={`chat-role-edit-${role.code}`}
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleActive(role)}
                          className="px-2 py-1 rounded hover:bg-gray-100 text-xs text-gray-600 hover:text-primary transition-colors cursor-pointer"
                          data-testid={`chat-role-toggle-${role.code}`}
                        >
                          {role.isActive ? tr('deactivate') : tr('activate')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(role)}
                          className="p-1.5 rounded hover:bg-red-50 text-gray-500 hover:text-red-600 transition-colors cursor-pointer"
                          aria-label={tr('deleteRole')}
                          data-testid={`chat-role-delete-${role.code}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {formModal.open && (
        <PatientChatRoleFormModal
          role={formModal.role}
          usageCount={formModal.role ? usage[formModal.role.code] ?? 0 : undefined}
          onSave={handleFormSave}
          onClose={() => setFormModal({ open: false, role: null })}
        />
      )}
    </PageContainer>
  );
}
