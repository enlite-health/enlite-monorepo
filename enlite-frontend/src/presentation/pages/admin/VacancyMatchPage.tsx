import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Calendar } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { useVacancyDetail } from '@hooks/admin/useVacancyDetail';
import { useVacancyMatch } from '@hooks/admin/useVacancyMatch';
import { MatchSummaryBar } from '@presentation/components/features/admin/VacancyMatch/MatchSummaryBar';
import { MatchCandidateRow } from '@presentation/components/features/admin/VacancyMatch/MatchCandidateRow';
import { MatchSelectionFooter } from '@presentation/components/features/admin/VacancyMatch/MatchSelectionFooter';
import { SendMessageModal } from '@presentation/components/features/admin/VacancyMatch/SendMessageModal';
import { ScheduleInterviewModal } from '@presentation/components/features/admin/VacancyMatch/ScheduleInterviewModal';
import type { SavedCandidate } from '../../../types/match';

// ── VacancyMatchPage ──────────────────────────────────────────────────────────────────────────

export default function VacancyMatchPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { vacancy } = useVacancyDetail(id);
  const { results, isLoading, isRunning, error, runMatch, markMessaged } = useVacancyMatch(id);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [minScore, setMinScore] = useState(0);
  const [modalCandidates, setModalCandidates] = useState<SavedCandidate[] | null>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);

  // Filtra candidatos pelo score mínimo (sem re-fetch)
  const filtered = useMemo(() => {
    if (!results?.candidates) return [];
    return results.candidates.filter(c => (c.matchScore ?? 0) >= minScore);
  }, [results, minScore]);

  const toggleSelect = (workerId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(workerId) ? next.delete(workerId) : next.add(workerId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filtered.length && filtered.length > 0) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(c => c.workerId)));
    }
  };

  const openModal = (candidates: SavedCandidate[]) => setModalCandidates(candidates);
  const closeModal = () => setModalCandidates(null);

  const handleSendBatch = () => {
    const toSend = filtered.filter(c => selected.has(c.workerId));
    openModal(toSend);
  };

  const handleScheduleBatch = () => setShowScheduleModal(true);
  const handleScheduled = () => {
    setShowScheduleModal(false);
    setSelected(new Set());
  };

  const handleSendOne = (candidate: SavedCandidate) => {
    openModal([candidate]);
  };

  const handleMessaged = (workerId: string, messagedAt: string) => {
    markMessaged(workerId, messagedAt);
  };

  const pageTitle = vacancy?.case_number != null && vacancy?.vacancy_number != null
    ? `Match — Caso ${vacancy.case_number}-${vacancy.vacancy_number}`
    : vacancy?.case_number != null
      ? `Match — Caso ${vacancy.case_number}`
      : 'Match de Candidatos';

  const allFilteredSelected =
    filtered.length > 0 && selected.size === filtered.length;

  return (
    <PageContainer className="pb-24">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/admin/vacancies/${id}`)}
            className="flex items-center gap-1 text-[#737373] hover:text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <Typography variant="body" weight="medium" className="text-inherit">
              Vaga
            </Typography>
          </button>
          <span className="text-[#D9D9D9]">/</span>
          <Typography variant="h1" weight="semibold" className="text-[#737373] font-poppins text-2xl">
            {pageTitle}
          </Typography>
        </div>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={handleScheduleBatch}
                className="flex items-center gap-2"
              >
                <Calendar className="w-4 h-4" />
                Agendar Entrevista
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSendBatch}
                className="flex items-center gap-2"
              >
                Enviar para {selected.size} selecionado{selected.size !== 1 ? 's' : ''}
              </Button>
            </>
          )}
          <Button
            variant={results ? 'outline' : 'primary'}
            size="sm"
            isLoading={isRunning}
            disabled={isLoading}
            onClick={() => runMatch()}
            className="flex items-center gap-2"
          >
            {isRunning ? (
              'Processando…'
            ) : results ? (
              'Rodar Novamente'
            ) : (
              'Rodar Match'
            )}
          </Button>
        </div>
      </div>

      {/* Loading inicial */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="w-10 h-10 text-primary animate-spin" />
        </div>
      )}

      {/* Erro */}
      {error && !isLoading && (
        <div className="flex items-center justify-center py-10">
          <Typography variant="body" className="text-red-600">{error}</Typography>
        </div>
      )}

      {/* Estado vazio — nunca rodou match */}
      {!isLoading && !error && !results && (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <Typography variant="h3" className="text-[#737373]">
            Nenhum match salvo ainda.
          </Typography>
          <Button variant="primary" size="lg" isLoading={isRunning} onClick={() => runMatch()}>
            Rodar Match
          </Button>
        </div>
      )}

      {/* Tabela de resultados */}
      {!isLoading && results && (
        <>
          <MatchSummaryBar
            totalCandidates={filtered.length}
            lastMatchAt={results.lastMatchAt}
            minScore={minScore}
            onMinScoreChange={setMinScore}
          />

          {filtered.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <Typography variant="body" className="text-[#737373]">
                Nenhum candidato com score ≥ {minScore}.
              </Typography>
            </div>
          ) : (
            <div className="rounded-xl overflow-hidden border border-[#ECEFF1]">
              <div className="overflow-x-auto">
              <table className="w-full border-collapse min-w-[800px]">
                <thead>
                  <tr className="h-11 bg-[#EEEEEE]">
                    <th className="px-3 w-10">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAll}
                        className="w-4 h-4 accent-primary cursor-pointer"
                      />
                    </th>
                    <th className="px-3 w-10 text-center">
                      <Typography variant="body" weight="medium" className="text-[#737373] font-lexend text-base">#</Typography>
                    </th>
                    <th className="px-4 text-left whitespace-nowrap">
                      <Typography variant="body" weight="medium" className="text-[#737373] font-lexend text-base">Nome</Typography>
                    </th>
                    <th className="px-4 text-left whitespace-nowrap">
                      <Typography variant="body" weight="medium" className="text-[#737373] font-lexend text-base">Status</Typography>
                    </th>
                    <th className="px-4 text-left whitespace-nowrap">
                      <Typography variant="body" weight="medium" className="text-[#737373] font-lexend text-base">Ocupação</Typography>
                    </th>
                    <th className="px-4 text-left whitespace-nowrap">
                      <Typography variant="body" weight="medium" className="text-[#737373] font-lexend text-base">Zona / Dist</Typography>
                    </th>
                    <th className="px-4 text-center whitespace-nowrap">
                      <Typography variant="body" weight="medium" className="text-[#737373] font-lexend text-base">Casos</Typography>
                    </th>
                    <th className="px-4 text-left whitespace-nowrap">
                      <Typography variant="body" weight="medium" className="text-[#737373] font-lexend text-base">Score Final</Typography>
                    </th>
                    <th className="px-3 w-16" />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((candidate, idx) => (
                    <MatchCandidateRow
                      key={candidate.workerId}
                      candidate={candidate}
                      rank={idx + 1}
                      isSelected={selected.has(candidate.workerId)}
                      onToggleSelect={toggleSelect}
                      onSendMessage={handleSendOne}
                    />
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Rodapé fixo com seleção */}
      <MatchSelectionFooter
        selectedCount={selected.size}
        onSendBatch={handleSendBatch}
        onClearSelection={() => setSelected(new Set())}
      />

      {/* Modal de envio */}
      {modalCandidates && id && (
        <SendMessageModal
          candidates={modalCandidates}
          vacancy={vacancy}
          vacancyId={id}
          onClose={closeModal}
          onMessaged={handleMessaged}
        />
      )}

      {/* Modal de agendamento de entrevista */}
      {showScheduleModal && id && (
        <ScheduleInterviewModal
          vacancyId={id}
          candidates={filtered.filter(c => selected.has(c.workerId))}
          onClose={() => setShowScheduleModal(false)}
          onScheduled={handleScheduled}
        />
      )}
    </PageContainer>
  );
}
