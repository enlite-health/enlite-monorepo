import { useTranslation } from 'react-i18next';
import { Eye } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';

export interface PatientRow {
  id: string;
  firstName: string;
  lastName: string;
  documentType: string | null;
  documentNumber: string | null;
  dependencyLevel: string | null;
  clinicalSpecialty: string | null;
  serviceType: string[];
  needsAttention: boolean;
  attentionReasons: string[];
}

interface PatientsTableProps {
  patients: PatientRow[];
  onRowClick?: (id: string) => void;
}

function StatusBadge({ needsAttention, reasons }: { needsAttention: boolean; reasons: string[] }) {
  const { t } = useTranslation();

  if (!needsAttention) {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-green-100 text-green-700"
        title={t('admin.patients.statusBadge.complete')}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
        <Text as="span" size="xs" weight="medium" color="inherit">
          {t('admin.patients.statusBadge.complete')}
        </Text>
      </span>
    );
  }

  const reasonLabels = reasons
    .map((r) => t(`admin.patients.reasonOptions.${r}`, r))
    .join(', ');

  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-700 cursor-help"
      title={reasonLabels || t('admin.patients.statusBadge.needsAttention')}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      <Text as="span" size="xs" weight="medium" color="inherit">
        {t('admin.patients.statusBadge.needsAttention')}
      </Text>
    </span>
  );
}

function formatDocument(type: string | null, number: string | null): string {
  if (!type && !number) return '—';
  if (type && number) return `${type} ${number}`;
  return number ?? type ?? '—';
}

function formatServiceType(types: string[]): string {
  if (!types || types.length === 0) return '—';
  return types.join(' + ');
}

function formatDependency(t: ReturnType<typeof useTranslation>['t'], level: string | null): string {
  if (!level) return '—';
  return t(`admin.patients.dependencyOptions.${level}`, level);
}

function formatSpecialty(t: ReturnType<typeof useTranslation>['t'], specialty: string | null): string {
  if (!specialty) return '—';
  return t(`admin.patients.specialtyOptions.${specialty}`, specialty);
}

export function PatientsTable({ patients, onRowClick }: PatientsTableProps): JSX.Element {
  const { t } = useTranslation();
  const safePatients = patients ?? [];

  return (
    <div className="w-full rounded-xl overflow-hidden border border-gray-400">
      <Table className="min-w-[600px]">
        <TableHeader>
          <TableHead className="w-10" />
          <TableHead className="whitespace-nowrap">{t('admin.patients.table.name')}</TableHead>
          <TableHead className="whitespace-nowrap">{t('admin.patients.table.document')}</TableHead>
          <TableHead className="whitespace-nowrap hidden md:table-cell">
            {t('admin.patients.table.dependency')}
          </TableHead>
          <TableHead className="whitespace-nowrap hidden lg:table-cell">
            {t('admin.patients.table.specialty')}
          </TableHead>
          <TableHead className="whitespace-nowrap hidden md:table-cell">
            {t('admin.patients.table.service')}
          </TableHead>
          <TableHead className="whitespace-nowrap">{t('admin.patients.table.status')}</TableHead>
        </TableHeader>
        <TableBody>
          {safePatients.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={7} className="h-[200px] bg-white text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.noPatients')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            safePatients.map((row) => {
              const fullName = [row.lastName, row.firstName].filter(Boolean).join(', ') || '—';
              return (
                <TableRow
                  key={row.id}
                  onClick={onRowClick ? () => onRowClick(row.id) : undefined}
                  className="bg-white h-[72px]"
                >
                  <TableCell unwrapped className="w-10">
                    <Eye className="w-5 h-5 text-gray-800" aria-label={t('admin.patients.table.view')} />
                  </TableCell>
                  <TableCell weight="medium">{fullName}</TableCell>
                  <TableCell weight="medium" className="whitespace-nowrap">
                    {formatDocument(row.documentType, row.documentNumber)}
                  </TableCell>
                  <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                    {formatDependency(t, row.dependencyLevel)}
                  </TableCell>
                  <TableCell weight="medium" className="whitespace-nowrap hidden lg:table-cell">
                    {formatSpecialty(t, row.clinicalSpecialty)}
                  </TableCell>
                  <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                    {formatServiceType(row.serviceType)}
                  </TableCell>
                  <TableCell unwrapped className="whitespace-nowrap">
                    <StatusBadge
                      needsAttention={row.needsAttention}
                      reasons={row.attentionReasons}
                    />
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
