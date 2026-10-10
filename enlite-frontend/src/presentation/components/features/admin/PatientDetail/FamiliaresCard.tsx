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
import { AdminPatientContactRowsApiService } from '@infrastructure/http/AdminPatientContactRowsApiService';
import type { PatientResponsibleDetail, EmergencyContactRef } from '@domain/entities/PatientDetail';
import { PatientResponsibleEditDrawer } from './edit/PatientResponsibleEditDrawer';
import { DeactivateResponsibleConfirm } from './DeactivateResponsibleConfirm';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';
import { EmergencyMarkButton, EmergencyMarkedBadge } from './EmergencyMarkButton';

interface FamiliaresCardProps {
  responsibles: PatientResponsibleDetail[];
  /** Spec 018, PR-2 (D-A): a marca de emergência vigente do paciente — para destacar a linha marcada. */
  emergencyContactRef?: EmergencyContactRef | null;
  /** Patient id — required to save the support-network section. */
  patientId?: string;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
  /** Spec 014 US-D1: pedido de foco do checklist ("falta responsable") — abre este drawer. */
  focusRequest?: DrawerFocusRequest | null;
}


export function FamiliaresCard({ responsibles, emergencyContactRef, patientId, onSaved, focusRequest }: FamiliaresCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<PatientResponsibleDetail | 'new' | null>(null);
  const [deactivating, setDeactivating] = useState<PatientResponsibleDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const rows = responsibles ?? [];
  const empty = '—';
  // O item "falta responsable" do checklist só existe quando NÃO há familiar ativo (PatientCompleteness
  // MISSING_SQL.RESPONSIBLE) → abre o drawer de criar. Havendo familiar, abre a edição do titular
  // (ou da 1ª linha, se não houver titular).
  useAutoOpenDrawer(focusRequest, 'RESPONSIBLE', () => setEditing(rows.length === 0 ? 'new' : (rows.find((r) => r.isPrimary) ?? rows[0])));

  const confirmDeactivate = async (): Promise<void> => {
    if (!deactivating || !patientId) return;
    setBusy(true);
    setDeactivateError(null);
    try {
      await AdminPatientContactRowsApiService.deactivateResponsible(patientId, deactivating.id);
      onSaved?.();
      setDeactivating(null);
    } catch {
      // lex C1.3: mensagem genérica, nunca eco do payload; o diálogo fica aberto para tentar de novo.
      setDeactivateError(t('admin.patients.editDrawer.saveError'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="familiares-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.familyCard.title')}
        </Heading>
        {/* "Nuevo" cria (POST) → patient_family:create; lápis e lixeira por linha → patient_family:update. */}
        <ActionButton resource="patient_family" action="create" variant="outline" size="sm" onClick={() => setEditing('new')} disabled={!patientId} className="flex items-center gap-1" data-testid="familiares-add">
          <Plus className="w-4 h-4" />
          {t('admin.patients.detail.new')}
        </ActionButton>
      </div>

      {editing && patientId && (
        <PatientResponsibleEditDrawer
          patientId={patientId}
          responsible={editing === 'new' ? null : editing}
          responsibles={rows}
          onClose={() => setEditing(null)}
          onSaved={() => onSaved?.()}
        />
      )}
      {deactivating && (
        <DeactivateResponsibleConfirm
          name={[deactivating.firstName, deactivating.lastName].filter(Boolean).join(' ').trim() || empty}
          busy={busy}
          error={deactivateError}
          onConfirm={confirmDeactivate}
          onClose={() => { setDeactivating(null); setDeactivateError(null); }}
        />
      )}

      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.familyCard.tableRelationship')}</TableHead>
          <TableHead>{t('admin.patients.detail.familyCard.tableIdentification')}</TableHead>
          <TableHead>{t('admin.patients.detail.familyCard.tableName')}</TableHead>
          <TableHead>{t('admin.patients.detail.familyCard.tablePhone')}</TableHead>
          <TableHead className="w-px whitespace-nowrap">{t('admin.patients.detail.externalContactsCard.tableEmergency')}</TableHead>
          <TableHead unwrapped>{null}</TableHead>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={6} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => {
              const fullName = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
              const docTypeLabel = r.documentType
                ? t(`admin.patients.detail.documentTypes.${r.documentType}`, r.documentType)
                : null;
              // Spec 018 PR-2 fix (Gabriel 13/09): "isMarked" é INFORMAÇÃO — mostra pra qualquer
              // ator com patient_family:read, mesmo sem :write (o botão abaixo é que é a AÇÃO e
              // esse sim some sem :write, D269).
              const isMarked = emergencyContactRef?.kind === 'RESPONSIBLE' && emergencyContactRef.id === r.id;
              return (
                <TableRow key={r.id} className="align-top">
                  {/* Spec 012 US-B5: o parentesco é ENUM (139) — traduzido, com fallback no cru. */}
                  <TableCell>{r.relationship ? t(`admin.patients.detail.relationshipOptions.${r.relationship}`, r.relationship) : empty}</TableCell>
                  <TableCell unwrapped>
                    <div className="flex flex-col">
                      <Text as="span" size="sm">{docTypeLabel ?? empty}</Text>
                      <Text as="span" size="xs" color="muted">
                        {r.documentNumber ?? empty}
                      </Text>
                    </div>
                  </TableCell>
                  <TableCell unwrapped>
                    <div className="flex flex-col">
                      <Text as="span" size="sm">{fullName || empty}</Text>
                      {r.email ? (
                        <Text as="span" size="xs" color="muted">
                          {r.email}
                        </Text>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>{r.phone ?? empty}</TableCell>
                  <TableCell unwrapped className="w-px whitespace-nowrap">
                    <div className="inline-flex items-center gap-1 whitespace-nowrap">
                      {isMarked && (
                        <EmergencyMarkedBadge
                          testId={`familiares-emergency-marked-${r.id}`}
                          label={t('admin.patients.detail.externalContactsCard.tableEmergency')}
                        />
                      )}
                      {patientId ? (
                        <EmergencyMarkButton
                          patientId={patientId}
                          kind="RESPONSIBLE"
                          contactId={r.id}
                          isMarked={isMarked}
                          onChanged={() => onSaved?.()}
                        />
                      ) : (!isMarked && empty)}
                    </div>
                  </TableCell>
                  <TableCell unwrapped align="right">
                    <div className="flex items-center justify-end gap-1">
                      <ActionButton
                        resource="patient_family" action="update" variant="outline" size="sm"
                        onClick={() => setEditing(r)} disabled={!patientId}
                        title={t('admin.patients.detail.familyCard.editResponsible')}
                        aria-label={t('admin.patients.detail.familyCard.editResponsible')}
                        className="p-2" data-testid={`familiares-edit-${r.id}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </ActionButton>
                      <ActionButton
                        resource="patient_family" action="update" variant="outline" size="sm"
                        onClick={() => { setDeactivateError(null); setDeactivating(r); }} disabled={!patientId}
                        title={t('admin.patients.detail.familyCard.deactivateResponsible')}
                        aria-label={t('admin.patients.detail.familyCard.deactivateResponsible')}
                        className="p-2 text-red-500" data-testid={`familiares-deactivate-${r.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </ActionButton>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
