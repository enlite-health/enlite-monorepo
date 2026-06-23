/**
 * DedupHistoryTab
 *
 * Displays the list of executed merges.
 * Each row shows phone, survivor ID, absorbed ID, category (via i18n),
 * date (toLocaleString es-AR), and a "Deshacer" button when can_undo=true.
 *
 * Uses the Table atom per CLAUDE.md spec.
 * Delegates undo to the parent via onUndo callback; modal lives in DedupCenterPage.
 */

import { useTranslation } from 'react-i18next';
import { AlertCircle, RotateCcw } from 'lucide-react';
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
} from '@presentation/components/atoms/Table/Table';
import type { MergeHistoryItem } from '@domain/entities/DedupGroup';

interface DedupHistoryTabProps {
  history: MergeHistoryItem[];
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onUndo: (auditId: string, phone: string) => void;
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4 animate-pulse" data-testid="history-skeleton">
      <div className="h-10 bg-slate-100 rounded-xl w-full" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 bg-slate-50 rounded w-full" />
      ))}
    </div>
  );
}

export function DedupHistoryTab({
  history,
  isLoading,
  error,
  onRetry,
  onUndo,
}: DedupHistoryTabProps) {
  const { t } = useTranslation();
  const h = (key: string, opts?: Record<string, unknown>) =>
    t(`admin.dedup.history.${key}`, opts ?? {});

  if (isLoading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div
        className="flex flex-col items-center gap-4 py-16 text-center"
        data-testid="history-error"
      >
        <AlertCircle className="w-12 h-12 text-red-400" />
        <Heading level={3} color="tertiary">
          {h('loadError')}
        </Heading>
        <Text size="sm" color="muted">
          {error}
        </Text>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('admin.dedup.retry')}
        </Button>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-16 text-center"
        data-testid="history-empty"
      >
        <RotateCcw className="w-10 h-10 text-slate-300" />
        <Heading level={3} color="tertiary">
          {h('empty')}
        </Heading>
        <Text size="sm" color="muted">
          {h('emptyDesc')}
        </Text>
      </div>
    );
  }

  return (
    <div
      className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4"
      data-testid="history-table-container"
    >
      <Table>
        <TableHeader>
          <TableHead>{h('col.phone')}</TableHead>
          <TableHead>{h('col.survivor')}</TableHead>
          <TableHead>{h('col.absorbed')}</TableHead>
          <TableHead>{h('col.category')}</TableHead>
          <TableHead>{h('col.date')}</TableHead>
          <TableHead>{h('col.actions')}</TableHead>
        </TableHeader>
        <TableBody>
          {history.map((item) => (
            <TableRow key={item.audit_id} clickable={false}>
              <TableCell weight="medium">{item.phone_normalized}</TableCell>
              <TableCell weight="medium">{item.survivor_name ?? '—'}</TableCell>
              <TableCell>
                <Text as="span" size="sm" color="muted">
                  {item.absorbed_name ?? '—'}
                </Text>
              </TableCell>
              <TableCell unwrapped>
                <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">
                  <Text as="span" size="xs" weight="medium" color="inherit">
                    {t(`admin.dedup.history.category.${item.category}`, {
                      defaultValue: item.category,
                    })}
                  </Text>
                </span>
              </TableCell>
              <TableCell>
                {new Date(item.created_at).toLocaleString('es-AR', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </TableCell>
              <TableCell unwrapped>
                {item.can_undo ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onUndo(String(item.audit_id), item.phone_normalized)}
                    aria-label={h('undoAriaLabel', {
                      phone: item.phone_normalized,
                    })}
                    data-testid={`undo-btn-${item.audit_id}`}
                  >
                    <RotateCcw className="w-4 h-4 mr-1" />
                    {h('undoBtn')}
                  </Button>
                ) : (
                  <Text as="span" size="xs" color="muted">
                    —
                  </Text>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
