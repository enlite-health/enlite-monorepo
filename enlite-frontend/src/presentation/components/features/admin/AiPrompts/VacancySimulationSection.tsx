/**
 * VacancySimulationSection — spec 029 (T073): "Simular creación de vacante", FORA das três abas.
 *
 * Criar uma vacante usa os três textos juntos; por isso o simulador recebe, da página, o texto que
 * está nos editores agora (`bodies`, rascunho não salvo incluído) e chama
 * `POST /api/admin/ai-prompts/simulate-vacancy`. O resultado é desenhado com as mesmas peças do
 * wizard de criação (`AIDescriptionEditor`, `PrescreeningStep`), SEMPRE em `readOnly`: não existe
 * aqui nenhum caminho para criar, publicar ou gravar.
 *
 * `PrescreeningStep` semeia o `useState` uma única vez a partir de `initialQuestions`/`initialFaq`;
 * por isso cada simulação nova remonta as peças com `key={runId}` (mesmo padrão de
 * `key={currentPrompt.slug}` em `AiPromptsPage`).
 *
 * O backend escolhe o prescreening pela VAGA. Se a pessoa editou o prompt do outro tipo, o texto
 * dela não entrou e a resposta não dá erro — `usedSlugs` alimenta o aviso visível abaixo.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';
import { Select } from '@presentation/components/atoms/Select';
import {
  AdminApiService,
  ApiError,
  type AiPromptBodies,
  type AiPromptSlug,
  type AiVacancySimulation,
} from '@infrastructure/http/AdminApiService';
import type { VacancyRow } from '@presentation/components/features/admin/VacanciesTable';
import { AIDescriptionEditor } from '@presentation/components/features/admin/TalentumConfig/AIDescriptionEditor';
import { PrescreeningStep } from '@presentation/components/features/admin/TalentumConfig/PrescreeningStep';
import { AI_PROMPT_TAB_I18N_KEYS } from '@presentation/pages/admin/AiPromptsPage/aiPromptTabs';

interface VacancySimulationSectionProps {
  /** Só os textos EDITADOS e não vazios; ausente = o backend usa o prompt salvo. */
  bodies: AiPromptBodies;
}

type CaseOption = { value: string; label: string };

interface Run {
  id: number;
  result: AiVacancySimulation;
  /** Os corpos que FORAM enviados nesta simulação (o aviso reflete o que foi enviado, não o que está no editor agora). */
  sent: AiPromptBodies;
}

const PRESCREENING_SLUGS: readonly AiPromptSlug[] = ['PRESCREENING_AT', 'PRESCREENING_CAREGIVER'];
const noop = (): void => {};

export function VacancySimulationSection({ bodies }: VacancySimulationSectionProps) {
  const { t } = useTranslation();
  const sc = (k: string, o?: Record<string, unknown>) => t(`admin.aiPrompts.simulation.${k}`, o);
  const slugLabel = (slug: AiPromptSlug) => t(AI_PROMPT_TAB_I18N_KEYS[slug]);

  const [cases, setCases] = useState<CaseOption[]>([]);
  const [casesState, setCasesState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [jobPostingId, setJobPostingId] = useState('');
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [runCount, setRunCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await AdminApiService.listVacancies({ limit: '100' });
        if (!alive) return;
        setCases(
          (data as VacancyRow[]).filter((v) => !v.isDraft).map((v) => ({ value: v.id, label: v.caso })),
        );
        setCasesState('ready');
      } catch {
        if (alive) setCasesState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const handleRun = async (): Promise<void> => {
    const sent = { ...bodies };
    setRunning(true);
    setError(null);
    try {
      const result = await AdminApiService.simulateVacancyCreation(jobPostingId, sent);
      const id = runCount + 1;
      setRunCount(id);
      setRun({ id, result, sent });
    } catch (err) {
      setRun(null);
      if (err instanceof ApiError && err.status === 503) setError(sc('errorUnavailable'));
      else if (err instanceof ApiError && err.status === 404) setError(sc('errorNotFound'));
      else setError(sc('error'));
    } finally {
      setRunning(false);
    }
  };

  // Texto editado de um prescreening que a vaga NÃO exercitou: entrou na requisição, mas o backend ignorou.
  const ignored = run
    ? PRESCREENING_SLUGS.filter((s) => run.sent[s] !== undefined && !run.result.usedSlugs.includes(s))
    : [];
  const usedPrescreening = run?.result.usedSlugs.find((s) => PRESCREENING_SLUGS.includes(s));

  return (
    <section className="flex flex-col gap-4 mt-10 pt-6 border-t border-gray-300" data-testid="vacancy-simulation-section">
      <div>
        <Heading level={2} weight="semibold" color="primary">{sc('title')}</Heading>
        <Text size="sm" color="muted" as="p">{sc('description')}</Text>
      </div>

      {casesState === 'loading' && (
        <Text size="xs" color="muted" data-testid="vacancy-simulation-cases-loading">{sc('casesLoading')}</Text>
      )}
      {casesState === 'error' && (
        <Text size="sm" role="alert" className="text-red-600" data-testid="vacancy-simulation-cases-error">
          {sc('casesError')}
        </Text>
      )}
      {casesState === 'ready' && cases.length === 0 && (
        <Text size="sm" color="muted" data-testid="vacancy-simulation-no-cases">{sc('noCases')}</Text>
      )}
      {casesState === 'ready' && cases.length > 0 && (
        <Select
          aria-label={sc('caseLabel')}
          options={cases}
          placeholder={sc('casePlaceholder')}
          value={jobPostingId}
          onValueChange={setJobPostingId}
          data-testid="vacancy-simulation-case"
        />
      )}

      <div>
        <Button
          variant="outline"
          onClick={handleRun}
          disabled={running || jobPostingId === ''}
          data-testid="vacancy-simulation-run"
        >
          {running ? sc('running') : sc('cta')}
        </Button>
      </div>

      {running && (
        <Text size="sm" color="muted" role="status" data-testid="vacancy-simulation-running">{sc('running')}</Text>
      )}

      {error && (
        <Text size="sm" role="alert" className="text-red-600" data-testid="vacancy-simulation-error">{error}</Text>
      )}

      {run && (
        <div className="flex flex-col gap-4" data-testid="vacancy-simulation-result">
          <div role="note" className="bg-amber-50 border border-amber-300 px-3 py-2 rounded" data-testid="vacancy-simulation-notice">
            <Text size="sm" weight="semibold">{sc('notice')}</Text>
          </div>

          <div className="flex flex-col gap-1" data-testid="vacancy-simulation-used">
            <Text size="xs" color="muted">
              {sc('usedTitle')}: {run.result.usedSlugs.map(slugLabel).join(' · ')}
            </Text>
          </div>

          {ignored.map((slug) => (
            <div
              key={slug}
              role="alert"
              className="bg-red-50 border border-red-300 px-3 py-2 rounded"
              data-testid={`vacancy-simulation-not-exercised-${slug}`}
            >
              <Text size="sm" weight="semibold">
                {sc('notExercised', { label: slugLabel(slug), used: usedPrescreening ? slugLabel(usedPrescreening) : '' })}
              </Text>
              <Text size="xs" color="muted">{sc('notExercisedDetail')}</Text>
            </div>
          ))}

          {run.result.description.trim() === '' ? (
            <Text size="sm" color="muted" data-testid="vacancy-simulation-empty-description">
              {sc('resultEmptyDescription')}
            </Text>
          ) : (
            <AIDescriptionEditor key={`d-${run.id}`} value={run.result.description} onChange={noop} readOnly />
          )}

          <PrescreeningStep
            key={`p-${run.id}`}
            initialQuestions={run.result.prescreening.questions}
            initialFaq={run.result.prescreening.faq}
            readOnly
          />
        </div>
      )}
    </section>
  );
}
