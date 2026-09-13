import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
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
import type { PatientExternalContactDetail, EmergencyContactRef } from '@domain/entities/PatientDetail';
import { PatientExternalContactsEditDrawer } from './edit/PatientExternalContactsEditDrawer';
import { EmergencyMarkButton } from './EmergencyMarkButton';

interface Props {
  externalContacts: PatientExternalContactDetail[];
  emergencyContactRef?: EmergencyContactRef | null;
  patientId?: string;
  onSaved?: () => void;
}

/**
 * "Red de contactos" — contatos externos SEM vínculo familiar (spec 018, PR-2, US-12, `lex` #4;
 * `contracts/support-network.md`). Vive ao lado de `FamiliaresCard`, na mesma célula
 * (`patient_family`): professor, escola, vizinho, empregador, gestor de caso, referente
 * comunitário. Cada linha pode virar a marca de emergência do paciente (D-A, `EmergencyMarkButton`).
 */
export function ExternalContactsCard({ externalContacts, emergencyContactRef, patientId, onSaved }: Props): JSX.Element {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const rows = externalContacts ?? [];
  const empty = '—';

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="external-contacts-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.externalContactsCard.title')}
        </Heading>
        <div className="flex items-center gap-3 flex-wrap">
          <ActionButton resource="patient_family" action="write" variant="outline" size="sm" onClick={() => setEditing(true)} disabled={!patientId} className="flex items-center gap-1" data-testid="edit-external-contacts-btn">
            <Plus className="w-4 h-4" />
            {t('admin.patients.detail.new')}
          </ActionButton>
        </div>
      </div>

      {editing && patientId && (
        <PatientExternalContactsEditDrawer
          patientId={patientId}
          externalContacts={rows}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}

      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.externalContactsCard.tableRelation')}</TableHead>
          <TableHead>{t('admin.patients.detail.externalContactsCard.tableName')}</TableHead>
          <TableHead>{t('admin.patients.detail.externalContactsCard.tablePhone')}</TableHead>
          <TableHead>{t('admin.patients.detail.externalContactsCard.tableEmergency')}</TableHead>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={4} className="py-6 text-center" data-testid="external-contacts-empty">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((c) => {
              const isMarked = emergencyContactRef?.kind === 'EXTERNAL' && emergencyContactRef.id === c.id;
              return (
                <TableRow key={c.id} className="align-top" data-clarity-mask="True" data-testid={`external-contact-row-${c.id}`}>
                  <TableCell>{t(`admin.patients.detail.externalContactRelationOptions.${c.relation}`, c.relation)}</TableCell>
                  <TableCell>{c.name || empty}</TableCell>
                  <TableCell>{c.phone ?? empty}</TableCell>
                  <TableCell unwrapped>
                    {patientId ? (
                      <EmergencyMarkButton patientId={patientId} kind="EXTERNAL" contactId={c.id} isMarked={isMarked} onChanged={() => onSaved?.()} />
                    ) : empty}
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
