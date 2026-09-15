import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, ShieldAlert } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import type { PatientResponsibleDetail, EmergencyContactRef } from '@domain/entities/PatientDetail';
import { PatientSupportNetworkEditDrawer } from './edit/PatientSupportNetworkEditDrawer';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';
import { EmergencyMarkButton } from './EmergencyMarkButton';

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
  const [editing, setEditing] = useState(false);
  useAutoOpenDrawer(focusRequest, 'RESPONSIBLE', () => setEditing(true));
  const rows = responsibles ?? [];
  const empty = '—';
  // Conserto rodada B (Gabriel 15/09): o drawer faz POST (linha nova) E PATCH (linha existente) —
  // o botão "Nuevo" abre pra quem tem QUALQUER UMA das duas células, não só `create`. Quem só tem
  // `update` tinha perdido a edição das linhas existentes.
  const { allowed: canCreateRow } = useActionGate('patient_family', 'create');
  const { allowed: canUpdateRow } = useActionGate('patient_family', 'update');
  const canOpenDrawer = canCreateRow || canUpdateRow;

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="familiares-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.familyCard.title')}
        </Heading>
        <div className="flex items-center gap-3 flex-wrap">
          {/* D269 — abre o drawer que grava por LINHA (spec 018, PR-1, ADR-1): POST /patients/:id/responsibles
              → patient_family:create, PATCH .../responsibles/:rid → patient_family:update (PR-8b). O botão
              "Nuevo" abre para QUALQUER UMA das duas — o drawer é quem gateia adicionar × editar por linha. */}
          {canOpenDrawer && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={!patientId} className="flex items-center gap-1" data-testid="edit-support-btn">
              <Plus className="w-4 h-4" />
              {t('admin.patients.detail.new')}
            </Button>
          )}
        </div>
      </div>

      {editing && patientId && (
        <PatientSupportNetworkEditDrawer
          patientId={patientId}
          responsibles={rows}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}

      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.familyCard.tableRelationship')}</TableHead>
          <TableHead>{t('admin.patients.detail.familyCard.tableIdentification')}</TableHead>
          <TableHead>{t('admin.patients.detail.familyCard.tableName')}</TableHead>
          <TableHead>{t('admin.patients.detail.familyCard.tablePhone')}</TableHead>
          <TableHead>{t('admin.patients.detail.externalContactsCard.tableEmergency')}</TableHead>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={5} className="py-6 text-center">
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
                  <TableCell unwrapped>
                    <div className="flex items-center gap-2 flex-wrap">
                      {isMarked && (
                        <span
                          className="inline-flex items-center gap-1 text-red-600"
                          data-testid={`familiares-emergency-marked-${r.id}`}
                        >
                          <ShieldAlert className="w-3.5 h-3.5" />
                          <Text as="span" size="xs" weight="semibold" color="inherit">
                            {t('admin.patients.detail.externalContactsCard.tableEmergency')}
                          </Text>
                        </span>
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
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
