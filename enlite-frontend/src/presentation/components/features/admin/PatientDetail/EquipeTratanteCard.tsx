/**
 * EquipeTratanteCard — equipe tratante do paciente, escrita POR LINHA (spec 018, PR-5, US-11;
 * `contracts/care-team.md`). "Nuevo"/lápis/desativar chamam `POST|PATCH|POST .../deactivate
 * /patients/:id/professionals[/:pid]` sob a célula NOVA `patient_care_team:write` — sem ela os
 * três botões SOMEM (`ActionButton` mode='hide', D269), nunca ficam desabilitados. A leitura
 * (a tabela em si) só existe atrás de `patient_care_team:read` — quem chama este card já está
 * sob `<ContainerGate resource="patient_care_team">` (`PatientDetailPage.tsx`).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { ActionButton } from '@presentation/components/features/access';
import type { PatientProfessionalDetail } from '@domain/entities/PatientDetail';
import { AdminPatientContactRowsApiService } from '@infrastructure/http/AdminPatientContactRowsApiService';
import { PatientProfessionalEditDrawer } from './edit/PatientProfessionalEditDrawer';
import { DeactivateProfessionalConfirm } from './DeactivateProfessionalConfirm';

interface EquipeTratanteCardProps {
  professionals: PatientProfessionalDetail[];
  /** Patient id — obrigatório para criar/editar/desativar (a leitura funciona sem, como antes). */
  patientId?: string;
  /** Chamado após create/update/deactivate com sucesso — a tela relê a ficha do servidor. */
  onSaved?: () => void;
}

export function EquipeTratanteCard({ professionals, patientId, onSaved }: EquipeTratanteCardProps) {
  const { t } = useTranslation();
  const safeProfessionals = professionals ?? [];
  const [editing, setEditing] = useState<PatientProfessionalDetail | 'new' | null>(null);
  const [deactivating, setDeactivating] = useState<PatientProfessionalDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const confirmDeactivate = async (): Promise<void> => {
    if (!deactivating || !patientId) return;
    setBusy(true);
    try {
      await AdminPatientContactRowsApiService.deactivateProfessional(patientId, deactivating.id);
      onSaved?.();
      setDeactivating(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="equipe-tratante-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.treatingTeamCard.title')}
        </Heading>
        {/* Célula NOVA `patient_care_team:write` (D269): sem ela o botão SOME, nunca fica cinza. */}
        <ActionButton resource="patient_care_team" action="create" variant="outline" size="sm" onClick={() => setEditing('new')} disabled={!patientId} className="flex items-center gap-1" data-testid="equipe-tratante-add">
          <Plus className="w-4 h-4" />
          {t('admin.patients.detail.new')}
        </ActionButton>
      </div>

      {editing && patientId && (
        <PatientProfessionalEditDrawer
          patientId={patientId}
          professional={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => onSaved?.()}
        />
      )}
      {deactivating && (
        <DeactivateProfessionalConfirm
          name={deactivating.name ?? '—'}
          busy={busy}
          onConfirm={confirmDeactivate}
          onClose={() => setDeactivating(null)}
        />
      )}

      {/* lex C2.1/C6: nome/telefone/e-mail/especialidade de terceiro é dado clínico do paciente —
          o Clarity (Balanced) não mascara texto por si só, então a linha inteira leva o atributo. */}
      <div data-clarity-mask="True">
      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.treatingTeamCard.tableFullName')}</TableHead>
          <TableHead>{t('admin.patients.detail.treatingTeamCard.tablePhoneNumber')}</TableHead>
          <TableHead>{t('admin.patients.detail.treatingTeamCard.tableSpecialty')}</TableHead>
          <TableHead>{t('admin.patients.detail.treatingTeamCard.tableProfile')}</TableHead>
          <TableHead unwrapped>{null}</TableHead>
        </TableHeader>
        <TableBody>
          {safeProfessionals.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={5} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            safeProfessionals.map((prof) => (
              <TableRow key={prof.id}>
                <TableCell>{prof.name ?? '—'}</TableCell>
                <TableCell>{prof.phone ?? '—'}</TableCell>
                <TableCell>
                  {prof.specialty
                    ? t(`admin.patients.detail.treatingTeamCard.specialtyOptions.${prof.specialty}`, prof.specialty)
                    : '—'}
                </TableCell>
                {/* lex C2.2: Perfil é o is_team da tabela, nunca derivado. */}
                <TableCell>{t(`admin.patients.detail.treatingTeamCard.${prof.isTeam ? 'isTeam' : 'professional'}`)}</TableCell>
                <TableCell unwrapped align="right">
                  <div className="flex items-center justify-end gap-1">
                    <ActionButton
                      resource="patient_care_team" action="update" variant="outline" size="sm"
                      onClick={() => setEditing(prof)} disabled={!patientId}
                      aria-label={t('admin.patients.detail.treatingTeamCard.editProfessional')}
                      className="p-2" data-testid={`equipe-tratante-edit-${prof.id}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </ActionButton>
                    <ActionButton
                      resource="patient_care_team" action="update" variant="outline" size="sm"
                      onClick={() => setDeactivating(prof)} disabled={!patientId}
                      aria-label={t('admin.patients.detail.treatingTeamCard.deactivateProfessional')}
                      className="p-2 text-red-500" data-testid={`equipe-tratante-deactivate-${prof.id}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </ActionButton>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}
