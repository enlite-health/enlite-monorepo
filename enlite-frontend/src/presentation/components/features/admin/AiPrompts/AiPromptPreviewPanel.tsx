/**
 * AiPromptPreviewPanel — spec 029 (T034): "escolher um caso e ver como o texto em edição vai sair".
 *
 * Usa o texto que está NO TEXTAREA (`body`), não o salvo — é o ponto da funcionalidade. O caso vem
 * da mesma listagem de vacantes da tela de vacantes (`AdminApiService.listVacancies`); rascunhos
 * ficam de fora (ainda não têm os dados que o gerador consulta). `POST .../preview` não grava e
 * não publica nada.
 *
 * O aviso de simulação é PERMANENTE enquanto houver resultado à vista: é um bloco fixo no fluxo
 * do documento, sem timer e sem toast. Erro (ex.: 503) só mostra mensagem aqui dentro — o `body`
 * pertence ao editor e nunca é tocado por este painel.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Select } from '@presentation/components/atoms/Select';
import { AdminApiService, ApiError, type AiPromptSlug } from '@infrastructure/http/AdminApiService';
import type { VacancyRow } from '@presentation/components/features/admin/VacanciesTable';

interface AiPromptPreviewPanelProps {
  slug: AiPromptSlug;
  /** Texto em edição (ainda não salvo). */
  body: string;
}

type CaseOption = { value: string; label: string };

export function AiPromptPreviewPanel({ slug, body }: AiPromptPreviewPanelProps) {
  const { t } = useTranslation();
  const pc = (k: string) => t(`admin.aiPrompts.preview.${k}`);

  const [cases, setCases] = useState<CaseOption[]>([]);
  const [casesState, setCasesState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [jobPostingId, setJobPostingId] = useState('');
  const [running, setRunning] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await AdminApiService.listVacancies({ limit: '100' });
        if (!alive) return;
        setCases(
          (data as VacancyRow[])
            .filter((v) => !v.isDraft)
            .map((v) => ({ value: v.id, label: v.caso })),
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

  // Trocar de aba/slug invalida o resultado anterior: ele pertence a outro prompt.
  useEffect(() => {
    setGenerated(null);
    setError(null);
  }, [slug]);

  const handleRun = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      const res = await AdminApiService.previewAiPrompt(slug, body, jobPostingId);
      setGenerated(res.generated);
    } catch (err) {
      setGenerated(null);
      setError(err instanceof ApiError && err.status === 503 ? pc('errorUnavailable') : pc('error'));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded border border-gray-300 p-3" data-testid="ai-prompt-preview-panel">
      <Text weight="semibold">{pc('title')}</Text>

      {casesState === 'loading' && (
        <Text size="xs" color="muted" data-testid="ai-prompt-preview-cases-loading">{pc('casesLoading')}</Text>
      )}
      {casesState === 'error' && (
        <Text size="sm" role="alert" className="text-red-600" data-testid="ai-prompt-preview-cases-error">
          {pc('casesError')}
        </Text>
      )}
      {casesState === 'ready' && (
        <Select
          aria-label={pc('caseLabel')}
          options={cases}
          placeholder={pc('casePlaceholder')}
          value={jobPostingId}
          onValueChange={setJobPostingId}
          data-testid="ai-prompt-preview-case"
        />
      )}

      <div>
        <Button
          variant="outline"
          onClick={handleRun}
          disabled={running || jobPostingId === '' || body.trim().length === 0}
          data-testid="ai-prompt-preview-run"
        >
          {running ? pc('loading') : pc('cta')}
        </Button>
      </div>

      {error && (
        <Text size="sm" role="alert" className="text-red-600" data-testid="ai-prompt-preview-error">
          {error}
        </Text>
      )}

      {generated !== null && (
        <div className="flex flex-col gap-2" data-testid="ai-prompt-preview-result">
          <div
            role="note"
            className="bg-amber-50 border border-amber-300 px-3 py-2 rounded"
            data-testid="ai-prompt-preview-notice"
          >
            <Text size="sm" weight="semibold">{pc('notice')}</Text>
          </div>
          <Text size="xs" color="muted">{pc('resultTitle')}</Text>
          <pre
            className="whitespace-pre-wrap break-words rounded bg-gray-50 p-3"
            data-testid="ai-prompt-preview-generated"
          >
            {generated}
          </pre>
        </div>
      )}
    </div>
  );
}
