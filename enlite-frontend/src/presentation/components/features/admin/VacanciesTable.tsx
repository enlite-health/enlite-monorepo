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
import {
  VACANCY_FUNNEL_COLUMNS,
  columnCount,
} from '@presentation/components/features/admin/VacancyDetail/Funnel/funnelTabsConfig';
import type { TableSort } from '@hooks/useTableSort';
import { formatVacancyCase } from '@domain/value-objects/caseNumberFormat';
import { formatDateTime } from '@presentation/components/features/admin/VacancyDetail/draftVacancyFormat';
import { isBajaSelectable } from './bajaSelectable';

export interface VacancyRow {
  id: string;
  /** Número do caso lido do paciente; null = vaga sem paciente visível (a célula mostra "—"). */
  caseNumber: number | null;
  /** Posição da vaga dentro do caso (`#01`). */
  caseOrdinal: number | null;
  status: string;
  diasAberto: string;
  /** As 8 contagens do funil (DX-2.7, Fase 4: +QUICK_RESPONSE_TEAM), recorte do board — vêm prontas do backend (stageCounts). */
  stageCounts: Record<string, number>;
  postulados: string;
  faltantes: string;
  isDraft: boolean;
  /** GREATEST(última nota, último movimento de funil, talentum_published_at) — DX-3.5. null = sem nenhuma. */
  lastActionAt: string | null;
  /** Spec 084: status cru (`DE_BAJA`, `SEARCHING`…); `status` é o rótulo. */
  statusRaw?: string | null;
  /** Spec 084: a vaga nasceu de um serviço contratado (P1: só vaga SEM serviço recebe baixa à mão). */
  hasService?: boolean;
  /** Spec 084 R13: `MANUAL_PAUSE` / `MANUAL_RESUME` = o Talentum recusou; a pessoa age à mão. */
  talentumPauseState?: string | null;
}


/** Chaves aceitas pelo backend (`VACANCY_SORT_ALLOWLIST`, spec 046 F3). Caso e Status não ordenam. */
export type VacancySortKey =
  | 'compatible' | 'invited' | 'iniciado' | 'preScreening' | 'bloqueados' | 'completed' | 'selected'
  | 'quickResponseTeam' | 'rejected' | 'postulados' | 'faltantes' | 'lastActionAt';

const FUNNEL_SORT_KEY: Record<string, VacancySortKey> = {
  COMPATIBLE: 'compatible',
  INVITED: 'invited',
  INICIADO: 'iniciado',
  PRE_SCREENING: 'preScreening',
  BLOQUEADO: 'bloqueados',
  COMPLETED: 'completed',
  SELECTED: 'selected',
  QUICK_RESPONSE_TEAM: 'quickResponseTeam',
  REJECTED: 'rejected',
};

interface VacanciesTableProps {
  sort?: TableSort<VacancySortKey> | null;
  onSort?: (key: VacancySortKey) => void;
  vacancies: VacancyRow[];
  /** F25/D425 (Fase 3) — o lápis saiu; o clique na linha inteira decide o destino,
   * inclusive a bifurcação por permissão em rascunho (`AdminVacanciesPage.tsx`). */
  onRowClick?: (id: string, isDraft: boolean) => void;
  /** Spec 084 F1: seleção para baixa em lote. Ausente = a coluna de seleção não existe (sem `vacancy:update`). */
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string) => void;
  onToggleAll?: (selectAll: boolean) => void;
}

const STATIC_COLUMNS_BEFORE = [
  { key: 'case', hiddenClass: '' },
  { key: 'status', hiddenClass: '' },
] as const;

const STATIC_COLUMNS_AFTER = [
  { key: 'applicants', hiddenClass: 'hidden md:table-cell', sortKey: 'postulados' },
  { key: 'missing', hiddenClass: 'hidden md:table-cell', sortKey: 'faltantes' },
] as const;

/** A lista mostra as mesmas colunas do funil (052: o estágio Confirmado saiu, o filtro local não é mais necessário). */
const LIST_FUNNEL_COLUMNS = VACANCY_FUNNEL_COLUMNS;

const TOTAL_COLUMNS =
  1 + // coluna do olho / seleção
  STATIC_COLUMNS_BEFORE.length +
  1 + // última ação
  LIST_FUNNEL_COLUMNS.length +
  STATIC_COLUMNS_AFTER.length;

export function VacanciesTable({
  vacancies, onRowClick, sort = null, onSort, selectedIds, onToggleSelect, onToggleAll,
}: VacanciesTableProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const safeVacancies = vacancies ?? [];
  const selectable = !!selectedIds && !!onToggleSelect;
  const eligible = safeVacancies.filter(isBajaSelectable);
  const allSelected = selectable && eligible.length > 0 && eligible.every((r) => selectedIds!.has(r.id));
  const sortProps = (key: VacancySortKey) =>
    onSort ? { onSort: () => onSort(key), sortDirection: sort?.key === key ? sort.direction : null } : {};

  return (
    <div className="w-full rounded-xl overflow-hidden border border-gray-400">
      <Table className="min-w-[500px]">
        <TableHeader>
          <TableHead className="w-10">
            {selectable && onToggleAll && eligible.length > 0 && (
              <input
                type="checkbox"
                className="w-4 h-4 cursor-pointer accent-primary"
                data-testid="vacancies-select-all"
                aria-label={t('admin.vacancies.baja.selectAll')}
                checked={allSelected}
                onChange={(e) => onToggleAll(e.target.checked)}
              />
            )}
          </TableHead>
          {STATIC_COLUMNS_BEFORE.map(({ key, hiddenClass }) => (
            <TableHead key={key} data-testid={`vacancies-col-${key}`} className={`whitespace-nowrap ${hiddenClass}`}>
              {t(`admin.vacancies.table.${key}`)}
            </TableHead>
          ))}
          <TableHead data-testid="vacancies-col-last-action" className="whitespace-nowrap" {...sortProps('lastActionAt')}>
            {t('admin.vacancies.table.lastAction')}
          </TableHead>
          {LIST_FUNNEL_COLUMNS.map((c) => (
            <TableHead key={c.id} data-testid={`vacancies-col-${c.id}`} className="whitespace-nowrap hidden md:table-cell" {...sortProps(FUNNEL_SORT_KEY[c.id])}>
              {t(`admin.kanban.columns.${c.id}`)}
            </TableHead>
          ))}
          {STATIC_COLUMNS_AFTER.map(({ key, hiddenClass, sortKey }) => (
            <TableHead key={key} data-testid={`vacancies-col-${key}`} className={`whitespace-nowrap ${hiddenClass}`} {...sortProps(sortKey)}>
              {t(`admin.vacancies.table.${key}`)}
            </TableHead>
          ))}
        </TableHeader>
        <TableBody>
          {safeVacancies.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={TOTAL_COLUMNS} className="h-[200px] bg-white text-center">
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
                    {selectable && isBajaSelectable(row) ? (
                      <input
                        type="checkbox"
                        className="w-4 h-4 cursor-pointer accent-primary"
                        data-testid={`vacancy-select-${row.id}`}
                        aria-label={t('admin.vacancies.baja.selectRow')}
                        checked={selectedIds!.has(row.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => onToggleSelect!(row.id)}
                      />
                    ) : (
                      <Eye className="w-4 h-4 text-gray-800" aria-label={t('admin.vacancies.table.view')} />
                    )}
                  </div>
                </TableCell>
                <TableCell weight="medium">{formatVacancyCase(row.caseNumber, row.caseOrdinal)}</TableCell>
                <TableCell unwrapped className="whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <Text as="span" size="sm" weight="medium">{row.status}</Text>
                    {row.statusRaw === 'DE_BAJA' && (
                      <span
                        className="inline-flex items-center bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full"
                        title={t('admin.vacancies.baja.readOnlyHint')}
                        data-testid={`vacancy-baja-badge-${row.id}`}
                      >
                        <Text as="span" size="xs" weight="medium" color="inherit">
                          {t('admin.vacancies.baja.badge')}
                        </Text>
                      </span>
                    )}
                    {(row.talentumPauseState === 'MANUAL_PAUSE' || row.talentumPauseState === 'MANUAL_RESUME') && (
                      <span
                        className="inline-flex items-center bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full"
                        data-testid={`vacancy-talentum-manual-badge-${row.id}`}
                      >
                        <Text as="span" size="xs" weight="medium" color="inherit">
                          {row.talentumPauseState === 'MANUAL_PAUSE'
                            ? t('admin.vacancies.baja.talentumManualBadge')
                            : t('admin.vacancies.baja.talentumManualResumeBadge')}
                        </Text>
                      </span>
                    )}
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
                <TableCell
                  className="whitespace-nowrap"
                  data-testid={`vacancies-row-${row.id}-last-action`}
                >
                  {formatDateTime(row.lastActionAt, i18n.language) ?? t('admin.vacancies.table.noLastAction')}
                </TableCell>
                {LIST_FUNNEL_COLUMNS.map((c) => (
                  <TableCell
                    key={c.id}
                    weight="medium"
                    className="whitespace-nowrap hidden md:table-cell"
                    data-testid={`vacancy-row-${row.id}-stage-${c.id}`}
                  >
                    {String(columnCount(c, row.stageCounts)).padStart(2, '0')}
                  </TableCell>
                ))}
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {row.postulados}
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
