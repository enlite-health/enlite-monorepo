import { AlertTriangle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { WorkerAvatar } from '@presentation/components/atoms/WorkerAvatar';
import type { SavedCandidate } from '../../../../../types/match';

interface MatchCandidateRowProps {
  candidate: SavedCandidate;
  selected: boolean;
  onToggleSelect: () => void;
  onInviteOne: () => void;
}

export function MatchCandidateRow({
  candidate,
  selected,
  onToggleSelect,
  onInviteOne,
}: MatchCandidateRowProps) {
  const distanceLabel =
    candidate.distanceKm != null ? `${candidate.distanceKm.toFixed(1)} km` : '—';
  const isAlreadyAllocated = candidate.activeCasesCount > 0;

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-400 last:border-0 hover:bg-gray-100 transition-colors">
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        className="w-4 h-4 accent-primary cursor-pointer"
        aria-label={`Seleccionar ${candidate.workerName}`}
      />
      <WorkerAvatar
        name={candidate.workerName}
        avatarUrl={null}
        size={40}
      />
      <div className="flex flex-col min-w-0 flex-1">
        <a
          href={`/admin/workers/${candidate.workerId}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="match-modal-worker-link"
          title={candidate.workerName ?? undefined}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 truncate rounded-sm hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Text as="span" size="sm" weight="medium" color="secondary" className="truncate">
            {candidate.workerName}
          </Text>
        </a>
        <Text as="span" size="xs" color="muted" className="truncate">
          {candidate.occupation ?? '—'}
        </Text>
      </div>
      <div className="flex flex-col items-end shrink-0">
        <Text as="span" size="sm" weight="medium" color="secondary">
          {distanceLabel}
        </Text>
        {isAlreadyAllocated && (
          <span className="inline-flex items-center gap-1 mt-0.5 text-amber-700">
            <AlertTriangle size={12} />
            <Text as="span" size="xs" weight="medium" color="inherit">
              Ya en {candidate.activeCasesCount} caso{candidate.activeCasesCount !== 1 ? 's' : ''}
            </Text>
          </span>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={onInviteOne} className="shrink-0">
        Invitar
      </Button>
    </div>
  );
}
