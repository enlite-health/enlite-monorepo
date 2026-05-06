import { Text } from '@presentation/components/atoms/Text';
import { MatchCandidateRow } from './MatchCandidateRow.match';
import type { DistanceBucket } from './matchModalHelpers';
import type { SavedCandidate } from '../../../../../types/match';

interface MatchBucketSectionProps {
  bucket: DistanceBucket;
  selectedIds: Set<string>;
  onToggleSelect: (workerId: string) => void;
  onInviteOne: (candidate: SavedCandidate) => void;
}

export function MatchBucketSection({
  bucket,
  selectedIds,
  onToggleSelect,
  onInviteOne,
}: MatchBucketSectionProps) {
  const isEmpty = bucket.candidates.length === 0;
  return (
    <div className="border border-gray-400 rounded-card overflow-hidden">
      <div className="bg-gray-300 px-4 py-2 flex items-center justify-between">
        <Text as="span" size="sm" weight="semibold" color="secondary">
          {bucket.label}
        </Text>
        <Text as="span" size="xs" color="muted">
          {bucket.candidates.length} candidato{bucket.candidates.length !== 1 ? 's' : ''}
        </Text>
      </div>
      {isEmpty ? (
        <div className="px-4 py-6 text-center">
          <Text size="sm" color="muted">Sin candidatos en este rango.</Text>
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
