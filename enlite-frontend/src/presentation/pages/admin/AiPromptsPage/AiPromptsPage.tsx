/**
 * AiPromptsPage — spec 029 (T024): moldura de administração dos prompts de IA editáveis.
 *
 * Três abas fixas (`aiPromptTabs.ts`, 1:1 com `AiPromptSlug`) trocadas LOCALMENTE (estado, não
 * rota) — molde `DedupTabs`/`DedupCenterPage` (pill ativa/inativa, descrição por aba). Carrega a
 * lista inteira com `listAiPrompts()` uma vez e escolhe o item da aba ativa; o editor em si
 * (`AiPromptEditor`, T023) é autônomo a partir daí — chama `update`/`undo` direto, não recebe
 * callback de salvar (só `onSaved`, para esta página atualizar a cópia local da lista).
 *
 * Gate — `useCellAccess('ai_prompt')`, como a tarefa manda:
 *   - `hidden` → nada é renderizado (sem contrato pronto, ou sem NENHUMA célula `ai_prompt:*`);
 *   - `read`   → conteúdo VISÍVEL, mas sem `AiPromptEditor`: um `Textarea` `readOnly` no lugar.
 *                `AiPromptEditor` não aceita prop para desabilitar o botão Salvar de fora (seu
 *                `canSave` só olha o próprio `saving`) — trocar de componente em vez de tentar
 *                desabilitar o de dentro é o único jeito de cumprir "salvar desabilitado" sem
 *                tocar no editor (fora do escopo desta task);
 *   - `write`  → `AiPromptEditor` completo.
 *
 * ⚠️ Achado (não corrigido aqui, ver tasks.md/LISTA da T024): `useCellAccess` não olha
 * `authz.enforcement` — ao contrário de `useActionGate` (usado dentro do editor só para o botão
 * Desfazer) e de `useContainerAccess` (usado por TODA página irmã — `DedupCenterPage`,
 * `BlockedAttemptsPage`, `TherapeuticCatalogPage` — exatamente para este tipo de gate). Com o
 * engine `off`/ausente (D268, o padrão hoje) e ninguém ainda com célula `ai_prompt:*` distribuída,
 * esta página fica `hidden` para todo mundo, enquanto o resto do painel continua fail-open. Ver
 * relatório da T024 para a análise completa.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCellAccess } from '@presentation/hooks/useCellAccess';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { AdminApiService, type AiPrompt } from '@infrastructure/http/AdminApiService';
import { AiPromptEditor } from '@presentation/components/features/admin/AiPrompts/AiPromptEditor';
import { AI_PROMPT_TABS, AI_PROMPT_TAB_I18N_KEYS, type AiPromptTab } from './aiPromptTabs';

// Mesmo par de classes do `DedupTabs.tsx` — não existe atom `Tabs` no painel (comentário original:
// "Pattern copied from VacancyDetailTabs.tsx:18-25").
const tabActive =
  'bg-primary text-white px-5 h-10 rounded-pill '
  + 'font-poppins font-semibold text-base whitespace-nowrap '
  + 'shadow-[0px_4px_20px_0px_rgba(0,0,0,0.4)] transition-colors flex items-center';

const tabInactive =
  'text-gray-800 hover:text-primary px-5 h-10 rounded-pill '
  + 'font-poppins font-semibold text-base whitespace-nowrap '
  + 'transition-colors flex items-center';

export function AiPromptsPage(): JSX.Element | null {
  const { t } = useTranslation();
  const tc = (k: string, o?: Record<string, unknown>) => t(`admin.aiPrompts.${k}`, o);

  // Trava por célula, exatamente como a tarefa manda — ver ⚠️ no cabeçalho do arquivo.
  const access = useCellAccess('ai_prompt');

  const [activeTab, setActiveTab] = useState<AiPromptTab>(AI_PROMPT_TABS[0]);
  const [prompts, setPrompts] = useState<AiPrompt[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const fetchPrompts = useCallback(async () => {
    try {
      setIsLoading(true);
      setLoadError(null);
      const data = await AdminApiService.listAiPrompts();
      setPrompts(data);
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Só busca quando há alguma leitura possível — `hidden` nem chega a chamar a API (o 403 viria
  // de qualquer forma do servidor, mas não há razão para tentar).
  useEffect(() => {
    if (access.canRead) fetchPrompts();
  }, [access.canRead, fetchPrompts]);

  // Notifica esta página quando o editor salva/desfaz, para a cópia local (e a troca de aba) não
  // ficarem com o `body`/`version` velhos.
  const handleSaved = useCallback((updated: AiPrompt) => {
    setPrompts((prev) => prev.map((p) => (p.slug === updated.slug ? updated : p)));
  }, []);

  const currentPrompt = useMemo(
    () => prompts.find((p) => p.slug === activeTab) ?? null,
    [prompts, activeTab],
  );

  if (access.level === 'hidden') return null;

  return (
    <PageContainer>
      <div className="mb-6">
        <Heading level={1} weight="semibold" color="primary">{tc('title')}</Heading>
        <Text size="sm" color="muted" as="p">{tc('description')}</Text>
      </div>

      <div className="mb-4" role="tablist" aria-label={tc('title')}>
        <div className="flex items-center gap-8 flex-wrap">
          {AI_PROMPT_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              onClick={() => setActiveTab(tab)}
              className={activeTab === tab ? tabActive : tabInactive}
              data-testid={`ai-prompt-tab-${tab}`}
            >
              {t(AI_PROMPT_TAB_I18N_KEYS[tab])}
            </button>
          ))}
        </div>
      </div>

      {access.level === 'read' && (
        <div
          className="bg-amber-50 border border-amber-200 px-4 py-2 rounded-lg mb-4"
          data-testid="ai-prompts-read-only-notice"
        >
          <Text size="xs" color="primary">{tc('readOnlyNotice')}</Text>
        </div>
      )}

      {isLoading && (
        <Text size="sm" color="secondary" data-testid="ai-prompts-loading">{tc('loading')}</Text>
      )}

      {!isLoading && loadError && (
        <Text size="sm" role="alert" className="text-red-600" data-testid="ai-prompts-load-error">
          {tc('loadError')}
        </Text>
      )}

      {!isLoading && !loadError && currentPrompt && (
        access.level === 'write' ? (
          <AiPromptEditor key={currentPrompt.slug} prompt={currentPrompt} onSaved={handleSaved} />
        ) : (
          <div className="flex flex-col gap-2" data-testid="ai-prompt-readonly">
            <Textarea
              value={currentPrompt.body}
              readOnly
              resize="vertical"
              rows={16}
              aria-label={tc('title')}
              data-testid="ai-prompt-readonly-textarea"
            />
          </div>
        )
      )}
    </PageContainer>
  );
}
