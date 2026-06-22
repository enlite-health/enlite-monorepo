/**
 * ImportedGroupsTab
 *
 * Content for the "Importados" tab in DedupCenterPage (Onda 4b).
 *
 * Shows:
 *  - Warning banner: name-match (not phone), review before merging.
 *  - Toggle "Solo con cuenta real" (default ON → onlyWithReal=true).
 *  - Table of imported duplicate groups (reuses DedupSignalBadge, atoms).
 *  - "Comparar & unificar" button per group → opens MergeCompareModal in
 *    direct-accounts mode (no phone endpoint needed).
 *  - Empty state when no groups.
 *  - Error state with retry.
 *  - Loading skeleton.
 *
 * Notes:
 *  - survivor_reason='conflict_multiple_real_accounts' highlights group row
 *    in amber and shows a "requiere revisión" badge. The modal still opens
 *    but the merge button is disabled inside it.
 *  - Uses Table atom; never raw <table>.
 *  - All text via i18n keys (admin.dedup.imported.*).
 */

import { useTranslation } from 'react-i18next';
import { GitMerge, AlertTriangle } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@presentation/components/atoms/Table';
import { DedupSignalBadge } from './DedupSignalBadge';
import type { ImportedDedupGroup } from '@domain/entities/DedupGroup';

interface ImportedGroupsTabProps {
  groups: ImportedDedupGroup[];
  isLoading: boolean;
  error: string | null;
  onlyWithReal: boolean;
  onToggleOnlyWithReal: (value: boolean) => void;
  onOpenMerge: (group: ImportedDedupGroup) => void;
  onRetry: () => void;
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4 animate-pulse" data-testid="imported-skeleton">
      <div className="h-12 bg-amber-50 rounded-xl w-full" />
      <div className="h-10 bg-slate-100 rounded-xl w-full" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 bg-slate-50 rounded w-full" />
      ))}
    </div>
  );
}

// new Date() + toLocaleString never throw in V8 (invalid input → 'Invalid Date' string).
// The try-catch that was here previously was dead code (confirmed exhaustive test).
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

export function ImportedGroupsTab({
  groups,
  isLoading,
  error,
  onlyWithReal,
  onToggleOnlyWithReal,
  onOpenMerge,
  onRetry,
}: ImportedGroupsTabProps) {
  const { t } = useTranslation();
  const d = (key: string) => t(`admin.dedup.imported.${key}`);

  if (isLoading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div
        className="flex flex-col items-center gap-4 py-16 text-center"
        data-testid="imported-error"
      >
        <AlertTriangle className="w-12 h-12 text-red-400" />
        <Heading level={3} color="tertiary">
          {d('loadError')}
        </Heading>
        <Text size="sm" color="muted">{error}</Text>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('admin.dedup.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="imported-content">
      {/* ── Name-match warning banner ─────────────────────────────────────── */}
      <div
        className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3 items-start"
        data-testid="imported-name-match-warning"
      >
        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
        <div>
          <Text size="sm" weight="semibold" color="inherit" as="p">
            {d('namematchWarningTitle')}
          </Text>
          <Text size="xs" color="muted" as="p">
            {d('namematchWarningDesc')}
          </Text>
        </div>
      </div>

      {/* ── Toggle: solo con cuenta real ─────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <label
          htmlFor="only-with-real-toggle"
          className="flex items-center gap-2 cursor-pointer select-none"
        >
          <div className="relative">
            <input
              id="only-with-real-toggle"
              type="checkbox"
              className="sr-only"
              checked={onlyWithReal}
              onChange={(e) => onToggleOnlyWithReal(e.target.checked)}
              data-testid="only-with-real-toggle"
            />
            <div
              className={`w-10 h-6 rounded-full transition-colors ${
                onlyWithReal ? 'bg-primary' : 'bg-slate-300'
              }`}
            />
            <div
              className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                onlyWithReal ? 'translate-x-4' : ''
              }`}
            />
          </div>
          <Text as="span" size="sm" weight="medium">
            {d('onlyWithRealLabel')}
          </Text>
        </label>
        <Text as="span" size="xs" color="muted">
          {onlyWithReal ? d('onlyWithRealHint') : d('allGroupsHint')}
        </Text>
      </div>

      {/* ── Content ───────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
        {groups.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 py-16 text-center"
            data-testid="imported-empty"
          >
            <GitMerge className="w-12 h-12 text-slate-300" />
            <Heading level={3} color="tertiary" weight="medium">
              {d('empty')}
            </Heading>
            <Text size="sm" color="muted">{d('emptyDesc')}</Text>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableHead align="center">{d('table.accountCount')}</TableHead>
              <TableHead>{d('table.signal')}</TableHead>
              <TableHead>{d('table.survivor')}</TableHead>
              <TableHead>{d('table.oldestAccount')}</TableHead>
              <TableHead>{d('table.reason')}</TableHead>
              <TableHead align="center">{d('table.actions')}</TableHead>
            </TableHeader>

            <TableBody>
              {groups.map((group, idx) => {
                const survivor = group.accounts.find(
                  (a) => a.id === group.survivor_suggested_id,
                );
                const isConflict =
                  group.survivor_reason === 'conflict_multiple_real_accounts';
                const oldest = group.accounts.reduce((a, b) =>
                  a.created_at < b.created_at ? a : b,
                );

                return (
                  <TableRow
                    key={`${group.survivor_suggested_id}-${idx}`}
                    clickable={false}
                  >
                    {/* Account count */}
                    <TableCell align="center">{group.accounts.length}</TableCell>

                    {/* Signal badge */}
                    <TableCell unwrapped>
                      <DedupSignalBadge accounts={group.accounts} />
                    </TableCell>

                    {/* Survivor email + tier */}
                    <TableCell unwrapped>
                      {survivor ? (
                        <div className="flex flex-col gap-0.5">
                          <Text as="span" size="sm" weight="medium">
                            {survivor.email ?? '—'}
                          </Text>
                          <span className="bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full inline-flex w-fit">
                            <Text as="span" size="xs" weight="medium" color="inherit">
                              {t(`admin.dedup.tier.${survivor.tier}`, {
                                defaultValue: survivor.tier,
                              })}
                            </Text>
                          </span>
                        </div>
                      ) : (
                        <Text as="span" size="sm" color="muted">—</Text>
                      )}
                    </TableCell>

                    {/* Oldest account date */}
                    <TableCell>{formatDate(oldest.created_at)}</TableCell>

                    {/* Reason badge */}
                    <TableCell unwrapped>
                      {isConflict ? (
                        <span
                          className="bg-red-100 text-red-700 px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                          data-testid={`conflict-badge-${idx}`}
                        >
                          <Text as="span" size="xs" weight="medium" color="inherit">
                            {d('reasonConflict')}
                          </Text>
                        </span>
                      ) : (
                        <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full inline-flex w-fit">
                          <Text as="span" size="xs" weight="medium" color="inherit">
                            {t(`admin.dedup.imported.reason.${group.survivor_reason}`, {
                              defaultValue: group.survivor_reason,
                            })}
                          </Text>
                        </span>
                      )}
                    </TableCell>

                    {/* Actions */}
                    <TableCell unwrapped>
                      <div className="flex items-center justify-center gap-2">
                        <Button
                          variant={isConflict ? 'outline' : 'primary'}
                          size="sm"
                          onClick={() => onOpenMerge(group)}
                          aria-label={t('admin.dedup.imported.table.mergeAriaLabel', {
                            count: group.accounts.length,
                          })}
                          data-testid={`imported-merge-btn-${idx}`}
                        >
                          {isConflict ? (
                            <AlertTriangle className="w-4 h-4 mr-1 text-amber-500" />
                          ) : (
                            <GitMerge className="w-4 h-4 mr-1" />
                          )}
                          {isConflict ? d('reviewBtn') : t('admin.dedup.table.merge')}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
