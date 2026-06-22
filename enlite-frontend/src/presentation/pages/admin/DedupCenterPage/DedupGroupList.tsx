/**
 * DedupGroupList
 *
 * Table of duplicate phone groups.
 * Columns: checkbox | phone | accounts | signal | survivor | actions
 *
 * Rules:
 * - uses Table atom (no raw <table>)
 * - inline badge pattern (NOT Badge atom) via DedupSignalBadge
 * - enums via i18n
 * - dates via toLocaleString('es-AR')
 */

import { useTranslation } from 'react-i18next';
import { GitMerge, Trash2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '@presentation/components/atoms/Table';
import { DedupSignalBadge } from './DedupSignalBadge';
import type { DedupGroupSummary } from '@domain/entities/DedupGroup';

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

interface DedupGroupListProps {
  groups: DedupGroupSummary[];
  selectedPhones: Set<string>;
  onToggleSelect: (phone: string) => void;
  onToggleSelectAll: () => void;
  onOpenMerge: (phone: string) => void;
  onDismiss: (phone: string) => void;
}

export function DedupGroupList({
  groups,
  selectedPhones,
  onToggleSelect,
  onToggleSelectAll,
  onOpenMerge,
  onDismiss,
}: DedupGroupListProps) {
  const { t } = useTranslation();
  const d = (key: string) => t(`admin.dedup.${key}`);

  const allSelected = groups.length > 0 && selectedPhones.size === groups.length;

  if (groups.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-16 text-center"
        data-testid="dedup-empty"
      >
        <GitMerge className="w-12 h-12 text-slate-300" />
        <Heading level={3} color="tertiary" weight="medium">
          {d('queue.empty')}
        </Heading>
        <Text size="sm" color="muted">
          {d('queue.emptyDesc')}
        </Text>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableHead unwrapped>
          <Checkbox
            checked={allSelected}
            onChange={onToggleSelectAll}
            aria-label={d('table.selectAll')}
          />
        </TableHead>
        <TableHead>{d('table.phone')}</TableHead>
        <TableHead align="center">{d('table.accountCount')}</TableHead>
        <TableHead>{d('table.signal')}</TableHead>
        <TableHead>{d('table.survivor')}</TableHead>
        <TableHead>{d('table.createdAt')}</TableHead>
        <TableHead align="center">{d('table.actions')}</TableHead>
      </TableHeader>

      <TableBody>
        {groups.map((group) => {
          const survivor = group.accounts.find(
            (a) => a.id === group.survivor_suggested,
          );
          const totalActivity =
            group.accounts.reduce(
              (sum, a) => sum + a.wja_count + a.docs_count,
              0,
            );

          return (
            <TableRow key={group.phone_normalized}>
              {/* Checkbox */}
              <TableCell unwrapped>
                <Checkbox
                  checked={selectedPhones.has(group.phone_normalized)}
                  onChange={() => onToggleSelect(group.phone_normalized)}
                  aria-label={t('admin.dedup.table.selectRow', {
                    phone: group.phone_normalized,
                  })}
                />
              </TableCell>

              {/* Phone */}
              <TableCell weight="medium">{group.phone_normalized}</TableCell>

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

              {/* Created at (oldest account) */}
              <TableCell>
                {formatDate(
                  group.accounts.reduce((earliest, a) =>
                    a.created_at < earliest.created_at ? a : earliest,
                  ).created_at,
                )}
              </TableCell>

              {/* Actions */}
              <TableCell unwrapped>
                <div className="flex items-center justify-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => onOpenMerge(group.phone_normalized)}
                    disabled={totalActivity === 0 && group.accounts.length < 2}
                    aria-label={t('admin.dedup.table.mergeAriaLabel', {
                      phone: group.phone_normalized,
                    })}
                  >
                    <GitMerge className="w-4 h-4 mr-1" />
                    {d('table.merge')}
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onDismiss(group.phone_normalized)}
                    aria-label={t('admin.dedup.table.dismissAriaLabel', {
                      phone: group.phone_normalized,
                    })}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
