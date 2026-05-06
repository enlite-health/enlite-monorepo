import { useTranslation } from 'react-i18next';
import { Eye, Pencil } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';

export interface VacancyRow {
  id: string;
  caso: string;
  status: string;
  grau: string;
  grauColor: string;
  diasAberto: string;
  convidados: string;
  postulados: string;
  selecionados: string;
  faltantes: string;
}

interface VacanciesTableProps {
  vacancies: VacancyRow[];
  onRowClick?: (id: string) => void;
  onEditClick?: (id: string) => void;
}

const COLUMNS = [
  { key: 'case', hiddenClass: '' },
  { key: 'status', hiddenClass: '' },
  { key: 'dependencyLevel', hiddenClass: '' },
  { key: 'invited', hiddenClass: 'hidden md:table-cell' },
  { key: 'applicants', hiddenClass: 'hidden md:table-cell' },
  { key: 'selected', hiddenClass: 'hidden md:table-cell' },
  { key: 'missing', hiddenClass: 'hidden md:table-cell' },
] as const;

export function VacanciesTable({ vacancies, onRowClick, onEditClick }: VacanciesTableProps): JSX.Element {
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
                onClick={onRowClick ? () => onRowClick(row.id) : undefined}
                className="bg-white h-[72px]"
              >
                <TableCell unwrapped className="w-10">
                  <div className="flex items-center gap-1.5">
                    <Eye className="w-4 h-4 text-gray-800" aria-label={t('admin.vacancies.table.view')} />
                    {onEditClick && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onEditClick(row.id); }}
                        className="p-0.5 hover:text-primary transition-colors"
                        aria-label={t('admin.vacancies.table.edit')}
                        data-testid={`edit-vacancy-${row.id}`}
                      >
                        <Pencil className="w-4 h-4 text-gray-800 hover:text-primary" />
                      </button>
                    )}
                  </div>
                </TableCell>
                <TableCell weight="medium">{row.caso}</TableCell>
                <TableCell weight="medium" className="whitespace-nowrap">{row.status}</TableCell>
                <TableCell unwrapped className="whitespace-nowrap">
                  <Text as="span" size="sm" weight="medium" className={row.grauColor}>
                    {row.grau}
                  </Text>
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {row.convidados}
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {row.postulados}
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
