import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Search } from 'lucide-react';
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
import { Button } from '@presentation/components/atoms/Button';
import type { PatientResponsibleDetail } from '@domain/entities/PatientDetail';
import { PatientSupportNetworkEditDrawer } from './edit/PatientSupportNetworkEditDrawer';

interface FamiliaresCardProps {
  responsibles: PatientResponsibleDetail[];
  /** Patient id — required to save the support-network section. */
  patientId?: string;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
}


export function FamiliaresCard({ responsibles, patientId, onSaved }: FamiliaresCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const rows = responsibles ?? [];
  const empty = '—';

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
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
            <input
              type="text"
              readOnly
              placeholder={t('admin.patients.detail.searchPlaceholder')}
              className="pl-9 pr-4 py-2 border border-gray-300 rounded-lg font-lexend text-sm text-gray-700 bg-gray-50 cursor-default outline-none"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)} disabled={!patientId} className="flex items-center gap-1" data-testid="edit-support-btn">
            <Plus className="w-4 h-4" />
            {t('admin.patients.detail.new')}
          </Button>
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
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={4} className="py-6 text-center">
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
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
