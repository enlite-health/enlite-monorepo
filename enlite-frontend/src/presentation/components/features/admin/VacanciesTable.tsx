import { useTranslation } from 'react-i18next';
import { Eye, FileText } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';

export type VacancyPriority = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';

export interface VacancyRow {
  id: string;
  caso: string;
  status: string;
  priority: VacancyPriority | null;
  diasAberto: string;
  convidados: string;
  postulados: string;
  confirmados: string;
  selecionados: string;
  faltantes: string;
  isDraft: boolean;
}

interface VacanciesTableProps {
  vacancies: VacancyRow[];
  /** F25/D425 (Fase 3) — o lápis saiu; o clique na linha inteira decide o destino,
   * inclusive a bifurcação por permissão em rascunho (`AdminVacanciesPage.tsx`). */
  onRowClick?: (id: string, isDraft: boolean) => void;
}

const COLUMNS = [
  { key: 'case', hiddenClass: '' },
  { key: 'status', hiddenClass: '' },
  { key: 'priority', hiddenClass: '' },
  { key: 'invited', hiddenClass: 'hidden md:table-cell' },
  { key: 'applicants', hiddenClass: 'hidden md:table-cell' },
  { key: 'confirmed', hiddenClass: 'hidden md:table-cell' },
  { key: 'selected', hiddenClass: 'hidden md:table-cell' },
  { key: 'missing', hiddenClass: 'hidden md:table-cell' },
] as const;

const PRIORITY_BADGE: Record<VacancyPriority, string> = {
  URGENT: 'bg-red-100 text-red-700',
  HIGH:   'bg-orange-100 text-orange-700',
  NORMAL: 'bg-slate-100 text-slate-700',
  LOW:    'bg-emerald-100 text-emerald-700',
};

function PriorityCell({ priority }: { priority: VacancyPriority | null }): JSX.Element {
  const { t } = useTranslation();
  if (!priority) {
    return <Text as="span" size="sm" weight="medium" color="secondary">—</Text>;
  }
  const badgeClass = PRIORITY_BADGE[priority];
  const label = t(`admin.vacancies.priorityOptions.${priority.toLowerCase()}`);
  return (
    <span className={`${badgeClass} px-2 py-0.5 rounded-full inline-block`}>
      <Text as="span" size="xs" weight="medium" color="inherit">
        {label}
      </Text>
    </span>
  );
}

export function VacanciesTable({ vacancies, onRowClick }: VacanciesTableProps): JSX.Element {
  const { t } = useTranslation();
  const safeVacancies = vacancies ?? [];

  return (
    <div className="w-full rounded-xl overflow-hidden border border-gray-400">
      <Table className="min-w-[500px]">
        <TableHeader>
          <TableHead className="w-10" />
          {COLUMNS.map(({ key, hiddenClass }) => (
            <TableHead key={key} className={`whitespace-nowrap ${hiddenClass}`}>
              {t(`admin.vacancies.table.${key}`)}
            </TableHead>
          ))}
        </TableHeader>
        <TableBody>
          {safeVacancies.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={COLUMNS.length + 1} className="h-[200px] bg-white text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.vacancies.noVacancies')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            safeVacancies.map((row) => (
              <TableRow
                key={row.id}
                data-testid={`vacancy-row-${row.id}`}
                onClick={onRowClick ? () => onRowClick(row.id, row.isDraft) : undefined}
                className="bg-white h-[72px]"
              >
                <TableCell unwrapped className="w-10">
                  <div className="flex items-center gap-1.5">
                    <Eye className="w-4 h-4 text-gray-800" aria-label={t('admin.vacancies.table.view')} />
                  </div>
                </TableCell>
                <TableCell weight="medium">{row.caso}</TableCell>
                <TableCell unwrapped className="whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <Text as="span" size="sm" weight="medium">{row.status}</Text>
                    {row.isDraft && (
                      <span
                        className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full"
                        title={t('admin.vacancies.table.draftBadge')}
                        data-testid={`vacancy-draft-badge-${row.id}`}
                      >
                        <FileText className="w-3 h-3" aria-hidden="true" />
                        <Text as="span" size="xs" weight="medium" color="inherit">
                          {t('admin.vacancies.table.draftBadge')}
                        </Text>
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell unwrapped className="whitespace-nowrap">
                  <PriorityCell priority={row.priority} />
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {row.convidados}
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {row.postulados}
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {row.confirmados}
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {row.selecionados}
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {row.faltantes}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
