import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { useVacancyMatch } from '@hooks/admin/useVacancyMatch';
import { useInviteProgressStore } from '@presentation/stores/inviteProgressStore';
import { ResendConfirmDialog } from './ResendConfirmDialog';
import { MatchCriteriaChips } from './MatchCriteriaChips';
import { MatchBucketSection } from './MatchBucketSection';
import { MatchTotalsMarker } from './MatchTotalsMarker';
import { MatchMissingMeetLinksAlert } from './MatchMissingMeetLinksAlert';
import {
  bucketize,
  hasAnyMeetLink,
  MATCH_RADIUS_KM,
  type VacancyForMatch,
} from './matchModalHelpers';
import type { SavedCandidate } from '../../../../../types/match';

interface MatchVacancyModalProps {
  vacancyId: string;
  vacancy: VacancyForMatch | undefined;
  onClose: () => void;
}

export function MatchVacancyModal({
  vacancyId,
  vacancy,
  onClose,
}: MatchVacancyModalProps) {
  const { t } = useTranslation();
  const { results, isLoading, isRunning, error, runMatch, markMessaged } =
    useVacancyMatch(vacancyId);

  // Garantir radius de 50km ao abrir o modal
  useEffect(() => {
    runMatch({ radiusKm: MATCH_RADIUS_KM });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enqueueInvites = useInviteProgressStore((s) => s.enqueue);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Candidatos aguardando decisão de re-envio (alguns já foram notificados).
  const [confirmTarget, setConfirmTarget] = useState<SavedCandidate[] | null>(
    null,
  );

  const meetLinksOk = useMemo(() => hasAnyMeetLink(vacancy), [vacancy]);

  const buckets = useMemo(
    () => bucketize(results?.candidates ?? []),
    [results],
  );

  const totalCandidates = useMemo(
    () => buckets.reduce((sum, b) => sum + b.candidates.length, 0),
    [buckets],
  );

  // AC3 (86ajb48v1): recrutados = candidatos com convite já enviado (messagedAt).
  const recruitedCount = useMemo(
    () => (results?.candidates ?? []).filter((c) => c.messagedAt != null).length,
    [results],
  );

  const selectedCandidates = useMemo(() => {
    if (!results) return [];
    return results.candidates.filter((c) => selectedIds.has(c.workerId));
  }, [results, selectedIds]);

  function toggleSelect(workerId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(workerId)) next.delete(workerId);
      else next.add(workerId);
      return next;
    });
  }

  // AC1 (86ajb48v1): "Seleccionar todos" por agrupamento de Km — marca/desmarca
  // todos os candidatos de um bucket de uma vez.
  function toggleSelectBucket(candidates: SavedCandidate[], select: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const c of candidates) {
        if (select) next.add(c.workerId);
        else next.delete(c.workerId);
      }
      return next;
    });
  }

  // Dispara o envio em background. Se algum candidato já foi notificado, abre a
  // confirmação de re-envio antes; senão, enfileira direto no painel flutuante.
  function startInvite(candidates: SavedCandidate[]) {
    if (!meetLinksOk || candidates.length === 0) return;
    const anyAlreadyNotified = candidates.some((c) => c.messagedAt != null);
    if (anyAlreadyNotified) {
      setConfirmTarget(candidates);
      return;
    }
    enqueueInvites(vacancyId, candidates, markMessaged);
  }

  function handleInviteOne(candidate: SavedCandidate) {
    startInvite([candidate]);
  }

  function handleInviteSelected() {
    startInvite(selectedCandidates);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4">
      <div
        data-testid="match-modal"
        className="bg-white rounded-card shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-400">
          <Heading level={2} weight="semibold" color="primary">
            {t('admin.match.title')}
          </Heading>
          <button
            onClick={onClose}
            className="text-gray-800 hover:text-primary transition-colors"
            aria-label={t('admin.match.closeAriaLabel')}
          >
            <X size={24} />
          </button>
        </div>

        {/* Critérios da vaga (display only) */}
        <div className="px-6 pt-5 pb-3 border-b border-gray-400">
          <MatchCriteriaChips vacancy={vacancy} />
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-4 bg-gray-100">
          {!meetLinksOk && (
            <MatchMissingMeetLinksAlert vacancyId={vacancyId} onClose={onClose} />
          )}

          {(isLoading || isRunning) && !results && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
              <Text size="sm" color="muted">{t('admin.match.loading')}</Text>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-card px-4 py-3">
              <Text size="sm" color="inherit" className="text-red-700">
                {error}
              </Text>
            </div>
          )}

          {results && totalCandidates === 0 && (
            <div className="text-center py-12">
              <Text size="sm" color="muted">
                {t('admin.match.noResultsInRadius', { km: MATCH_RADIUS_KM })}
              </Text>
            </div>
          )}

          {results && totalCandidates > 0 && (
            <div className="flex flex-col gap-4">
              <MatchTotalsMarker
                availableCount={totalCandidates}
                recruitedCount={recruitedCount}
              />
              {buckets.map((bucket) => (
                <MatchBucketSection
                  key={bucket.label}
                  bucket={bucket}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onToggleSelectAll={toggleSelectBucket}
                  onInviteOne={handleInviteOne}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-6 border-t border-gray-400">
          <Text size="sm" color="muted">
            {t('admin.match.selectedCount', { count: selectedIds.size })}
          </Text>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="md" onClick={onClose}>
              {t('admin.match.close')}
            </Button>
            <Button
              variant="primary"
              size="md"
              disabled={selectedIds.size === 0 || !meetLinksOk}
              onClick={handleInviteSelected}
            >
              {t('admin.match.inviteSelected', { count: selectedIds.size })}
            </Button>
          </div>
        </div>
      </div>

      {confirmTarget && (
        <ResendConfirmDialog
          alreadyCount={confirmTarget.filter((c) => c.messagedAt != null).length}
          newCount={confirmTarget.filter((c) => c.messagedAt == null).length}
          onResendAll={() => {
            enqueueInvites(vacancyId, confirmTarget, markMessaged);
            setConfirmTarget(null);
          }}
          onNewOnly={() => {
            enqueueInvites(
              vacancyId,
              confirmTarget.filter((c) => c.messagedAt == null),
              markMessaged,
            );
            setConfirmTarget(null);
          }}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
