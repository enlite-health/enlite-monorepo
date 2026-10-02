import type { ReactNode } from 'react';
import { resolveDateLocale, SHORT_DATE_OPTIONS } from '@presentation/utils/dateLocale';
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
import { getPlatformLabel } from '@presentation/pages/admin/workersData';
import { DocsStatusBadge } from '@presentation/components/atoms/DocsStatusBadge';

export interface WorkerRow {
  id: string;
  name: string;
  email: string | null;
  casesCount: number;
  documentsComplete: boolean;
  documentsStatus: string;
  platform: string;
  createdAt: string;
  /** Checkbox "Mostrar desactivados" (D-2026-09-28). `'DISABLED'` = baixa de conta. */
  status?: string;
}

interface WorkersTableProps {
  /** REQ-09: célula de ação por linha (ex.: convite à reunión de presentación). Ausente = sem coluna. */
  renderAction?: (row: WorkerRow) => ReactNode;
  workers: WorkerRow[];
  onRowClick?: (id: string) => void;
}

const COLUMNS = [
  { key: 'name', hiddenClass: '' },
  { key: 'cases', hiddenClass: '' },
  { key: 'documents', hiddenClass: '' },
  { key: 'registeredAt', hiddenClass: 'hidden md:table-cell' },
  { key: 'platform', hiddenClass: 'hidden md:table-cell' },
] as const;

function formatDate(iso: string, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(resolveDateLocale(locale), SHORT_DATE_OPTIONS);
}

/**
 * Badge do checkbox "Mostrar desactivados" (D-2026-09-28) — mesmo molde do
 * `DocsStatusBadge` (pill + dot). `slate-100`/`slate-700` (escala PADRÃO do
 * Tailwind, não a `gray-*` deste tema — `gray-100..800` aqui são cores de marca
 * customizadas e ALGUMAS são translúcidas, ex. `gray-700` = rgba(115,115,115,.5);
 * usar uma delas como texto sólido foi o que causou o badge de baixo contraste
 * na tela de pacientes). Contraste medido (fórmula WCAG, sRGB→luminância
 * relativa): slate-100 `#F1F5F9` × slate-700 `#334155` → ~9,45:1, acima do
 * mínimo 4,5:1 AA para texto normal.
 */
function DeactivatedBadge() {
  const { t } = useTranslation();
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700"
      title={t('admin.workers.statusBadge.deactivated')}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
      <Text as="span" size="xs" weight="medium" color="inherit">
        {t('admin.workers.statusBadge.deactivated')}
      </Text>
    </span>
  );
}

export function WorkersTable({ workers, onRowClick, renderAction }: WorkersTableProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const safeWorkers = workers ?? [];

  return (
    <div className="w-full rounded-xl overflow-hidden border border-gray-400">
      <Table className="min-w-[500px]">
        <TableHeader>
          <TableHead className="w-10" />
          {COLUMNS.map(({ key, hiddenClass }) => (
            <TableHead key={key} className={`whitespace-nowrap ${hiddenClass}`}>
              {t(`admin.workers.table.${key}`)}
            </TableHead>
          ))}
          {renderAction && <TableHead className="whitespace-nowrap">{t('admin.workers.table.actions')}</TableHead>}
        </TableHeader>
        <TableBody>
          {safeWorkers.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={COLUMNS.length + (renderAction ? 2 : 1)} className="h-[200px] bg-white text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.workers.noWorkers')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            safeWorkers.map((row) => (
              <TableRow
                key={row.id}
                onClick={onRowClick ? () => onRowClick(row.id) : undefined}
                className="bg-white h-[72px]"
              >
                <TableCell unwrapped className="w-10">
                  <Eye className="w-5 h-5 text-gray-800" aria-label={t('admin.workers.table.view')} />
                </TableCell>
                <TableCell unwrapped>
                  <div className="flex flex-col">
                    <Text as="span" size="sm" weight="medium" color="secondary">
                      {row.name}
                    </Text>
                    <Text as="span" size="xs" color="muted">
                      {row.email || '—'}
                    </Text>
                  </div>
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap">
                  {row.casesCount}
                </TableCell>
                <TableCell unwrapped className="whitespace-nowrap">
                  {row.status === 'DISABLED' ? (
                    <span data-testid={`worker-row-${row.id}-deactivated-badge`}>
                      <DeactivatedBadge />
                    </span>
                  ) : (
                    <DocsStatusBadge complete={row.documentsComplete} status={row.documentsStatus} />
                  )}
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {formatDate(row.createdAt, i18n.language)}
                </TableCell>
                <TableCell weight="medium" className="whitespace-nowrap hidden md:table-cell">
                  {getPlatformLabel(t, row.platform)}
                </TableCell>
                {renderAction && (
                  <TableCell unwrapped className="whitespace-nowrap min-w-[190px]" onClick={(e) => e.stopPropagation()}>
                    {renderAction(row)}
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
