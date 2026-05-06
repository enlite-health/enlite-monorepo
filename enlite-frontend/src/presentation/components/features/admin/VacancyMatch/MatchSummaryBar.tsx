import { Text } from '@presentation/components/atoms/Text';

interface MatchSummaryBarProps {
  totalCandidates: number;
  lastMatchAt: string | null;
  minScore: number;
  onMinScoreChange: (value: number) => void;
}

export function MatchSummaryBar({
  totalCandidates,
  lastMatchAt,
  minScore,
  onMinScoreChange,
}: MatchSummaryBarProps) {
  const lastMatchLabel = lastMatchAt
    ? new Date(lastMatchAt).toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="flex items-center justify-between bg-white border border-[#D9D9D9] rounded-xl px-5 py-3 mb-4">
      <div className="flex items-center gap-4">
        <Text size="sm" weight="medium" color="secondary">
          {totalCandidates} candidato{totalCandidates !== 1 ? 's' : ''}
        </Text>
        {lastMatchLabel && (
          <>
            <span className="text-[#D9D9D9]">|</span>
            <Text size="sm" color="secondary">
              Último match: {lastMatchLabel}
            </Text>
          </>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Text size="sm" color="secondary" className="whitespace-nowrap">
          Score mínimo
        </Text>
        <input
          type="number"
          min={0}
          max={100}
          value={minScore}
          onChange={(e) => onMinScoreChange(Number(e.target.value))}
          className="w-16 border border-slate-200 rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:ring-0 focus:border-primary"
        />
      </div>
    </div>
  );
}
