import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { MatchCandidateRow } from './MatchCandidateRow.match';
import type { DistanceBucket } from './matchModalHelpers';
import type { SavedCandidate } from '../../../../../types/match';

interface MatchBucketSectionProps {
  bucket: DistanceBucket;
  selectedIds: Set<string>;
  onToggleSelect: (workerId: string) => void;
  onToggleSelectAll: (candidates: SavedCandidate[], select: boolean) => void;
  onInviteOne: (candidate: SavedCandidate) => void;
}

export function MatchBucketSection({
  bucket,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onInviteOne,
}: MatchBucketSectionProps) {
  const { t } = useTranslation();
  const isEmpty = bucket.candidates.length === 0;

  const selectedInBucket = useMemo(
    () => bucket.candidates.filter((c) => selectedIds.has(c.workerId)).length,
    [bucket.candidates, selectedIds],
  );
  const allSelected = !isEmpty && selectedInBucket === bucket.candidates.length;
  const someSelected = selectedInBucket > 0 && !allSelected;

  // Checkbox tri-state: "indeterminate" só existe via DOM (não é prop React).
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <div className="border border-gray-400 rounded-card overflow-hidden">
      <div className="bg-gray-300 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          {!isEmpty && (
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allSelected}
              onChange={() => onToggleSelectAll(bucket.candidates, !allSelected)}
              className="w-4 h-4 accent-primary cursor-pointer"
              aria-label={t('admin.match.selectAllInGroup', { group: bucket.label })}
            />
          )}
          <Text as="span" size="sm" weight="semibold" color="secondary" className="truncate">
            {bucket.label}
          </Text>
        </div>
        <Text as="span" size="xs" color="muted">
          {t('admin.match.candidatesCount', { count: bucket.candidates.length })}
        </Text>
      </div>
      {isEmpty ? (
        <div className="px-4 py-6 text-center">
          <Text size="sm" color="muted">{t('admin.match.emptyBucket')}</Text>
        </div>
      ) : (
        <div className="bg-white">
          {bucket.candidates.map((c) => (
            <MatchCandidateRow
              key={c.workerId}
              candidate={c}
              selected={selectedIds.has(c.workerId)}
              onToggleSelect={() => onToggleSelect(c.workerId)}
              onInviteOne={() => onInviteOne(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
