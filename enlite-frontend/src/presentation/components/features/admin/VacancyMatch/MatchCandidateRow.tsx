import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { MatchScoreBar } from './MatchScoreBar';
import { Text } from '@presentation/components/atoms/Text';
import { TableRow, TableCell } from '@presentation/components/atoms/Table';
import { DocsStatusBadge } from '@presentation/components/atoms/DocsStatusBadge';
import type { SavedCandidate } from '../../../../../types/match';

interface MatchCandidateRowProps {
  candidate: SavedCandidate;
  rank: number;
  isSelected: boolean;
  onToggleSelect: (workerId: string) => void;
  onSendMessage: (candidate: SavedCandidate) => void;
}

const STATUS_COLORS: Record<string, string> = {
  QUALIFICADO:     'bg-green-100 text-green-700',
  'PRÉ-TALENTUM':  'bg-blue-100 text-blue-700',
  'PRE-TALENTUM':  'bg-blue-100 text-blue-700',
  TALENTUM:        'bg-purple-100 text-purple-700',
  BLACKLIST:       'bg-red-100 text-red-700',
};

function statusColor(status: string | null): string {
  if (!status) return 'bg-gray-100 text-gray-600';
  return STATUS_COLORS[status.toUpperCase()] ?? 'bg-gray-100 text-gray-600';
}

export function MatchCandidateRow({
  candidate,
  rank,
  isSelected,
  onToggleSelect,
  onSendMessage,
}: MatchCandidateRowProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const messagedLabel = candidate.messagedAt
    ? new Date(candidate.messagedAt).toLocaleDateString(i18n.language === 'pt-BR' ? 'pt-BR' : 'es-AR', {
        day: '2-digit',
        month: '2-digit',
      })
    : null;

  const distanceLabel = candidate.distanceKm != null
    ? `${candidate.distanceKm.toFixed(1)} km`
    : null;

  const zoneLabel = [candidate.workZone, distanceLabel].filter(Boolean).join(' · ');
  const score = candidate.matchScore ?? 0;

  const hasExpansion = !!(candidate.internalNotes);

  return (
    <>
      <TableRow className={isSelected ? 'bg-primary/5' : ''}>
        <TableCell unwrapped className="w-10">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(candidate.workerId)}
            className="w-4 h-4 accent-primary cursor-pointer"
          />
        </TableCell>

        <TableCell align="center" className="w-10">
          {rank}
        </TableCell>

        <TableCell unwrapped>
          <div className="flex items-center gap-2">
            <button
              className="text-left hover:text-primary transition-colors"
              onClick={() => hasExpansion && setExpanded(!expanded)}
            >
              <Text as="span" size="sm" weight="medium" color="secondary">
                {candidate.workerName}
              </Text>
            </button>
            {candidate.alreadyApplied && (
              <span className="px-2 py-0.5 bg-blue-100 text-blue-600 rounded-full whitespace-nowrap">
                <Text as="span" size="xs" color="inherit">{t('admin.match.alreadyApplied')}</Text>
              </span>
            )}
            {messagedLabel && (
              <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full whitespace-nowrap">
                <Text as="span" size="xs" color="inherit">{t('admin.match.notified', { date: messagedLabel })}</Text>
              </span>
            )}
          </div>
        </TableCell>

        <TableCell unwrapped>
          <span className={`inline-flex px-2 py-0.5 rounded-full ${statusColor(candidate.overallStatus)}`}>
            <Text as="span" size="xs" weight="medium" color="inherit">
              {candidate.overallStatus ?? '—'}
            </Text>
          </span>
        </TableCell>

        <TableCell unwrapped className="whitespace-nowrap">
          <DocsStatusBadge status={candidate.documentStatus} />
        </TableCell>

        <TableCell unwrapped>
          <Text as="span" size="sm" color="muted">{candidate.occupation ?? '—'}</Text>
        </TableCell>

        <TableCell unwrapped>
          <Text as="span" size="sm" color="muted">{zoneLabel || '—'}</Text>
        </TableCell>

        <TableCell unwrapped align="center">
          <Text as="span" size="sm" color="muted">{candidate.activeCasesCount}</Text>
        </TableCell>

        <TableCell unwrapped>
          <MatchScoreBar score={score} />
        </TableCell>

        <TableCell unwrapped className="w-16">
          <div className="flex items-center gap-1">
            <button
              onClick={() => onSendMessage(candidate)}
              title={t('admin.match.sendWhatsappTooltip')}
              aria-label={t('admin.match.sendWhatsappTooltip')}
              className="p-1.5 rounded-lg text-gray-800 hover:text-green-600 hover:bg-green-50 transition-colors"
            >
              <MessageCircle className="w-4 h-4" />
            </button>
            {hasExpansion && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="p-1.5 rounded-lg text-gray-800 hover:text-primary hover:bg-primary/10 transition-colors"
              >
                {expanded ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>
            )}
          </div>
        </TableCell>
      </TableRow>

      {expanded && candidate.internalNotes && (
        <TableRow className="bg-gray-50">
          <TableCell unwrapped colSpan={10} className="px-6 py-3">
            <Text size="sm" color="muted" className="italic leading-relaxed">
              {candidate.internalNotes}
            </Text>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
