/**
 * AiPromptEditor — spec 029 (T023/T023a): área de texto de UM prompt de IA editável, com
 * contador, autoria da versão atual, salvar e desfazer.
 *
 * Molde: `VacancyTalentumCard.tsx` (estado próprio + `AdminApiService` chamado direto, sem
 * passar por callback do pai) e `LocalizacoesCard.tsx` (captura de `ApiError`/409 com
 * `err.status === 409`, canal de erro `<Text role="alert">`). O contador e a leitura do atom
 * `Textarea` seguem `ClinicalTextareaField.tsx`; "Última edição: data · nome" segue
 * `ClinicalLongText.tsx` (`formatDateTime` com `resolveDateLocale`/`SHORT_DATE_OPTIONS`).
 *
 * Autônomo: recebe o prompt já carregado (`AiPromptsPage`, T024, faz `listAiPrompts` e escolhe a
 * aba) e chama `updateAiPrompt`/`undoAiPrompt`/`getAiPrompt` diretamente — não depende de um
 * `onSave` do pai. `onSaved` é só notificação, para o pai atualizar a lista se quiser.
 *
 * 409 ao salvar ou desfazer: o corpo da resposta trai `currentVersion`/`updatedBy` (contrato,
 * `AiPromptController.ts:update/undo`), mas `ApiError` (molde geral de `AdminApiService`, fora do
 * escopo desta task) só guarda `code`/`reason`/`workerStatus`/`missingFields` — os dois campos
 * daquele payload são perdidos na conversão. Por isso "mostrar quem alterou" refaz a leitura com
 * `getAiPrompt(slug)` (mesma permissão de leitura, sem custo extra de escopo) e usa o `updatedBy`
 * fresco para a mensagem `errors.versionConflict`.
 *
 * Desfazer "sem versão anterior" (FR-036): sem campo próprio no contrato, o sinal é `version > 1`
 * — a `migration 487` semeia a versão 1, e só a partir da 2 existe um evento anterior pra desfazer
 * (mesma regra que `UndoAiPromptUseCase` aplica no servidor). Botão só existe (D269, hide) para
 * quem tem `ai_prompt:update` — mesma célula de salvar (contrato).
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveDateLocale, SHORT_DATE_OPTIONS } from '@presentation/utils/dateLocale';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { AdminApiService, ApiError, type AiPrompt, type AiPromptSlug } from '@infrastructure/http/AdminApiService';

interface AiPromptEditorProps {
  prompt: AiPrompt;
  /** Notifica o pai depois de salvar/desfazer com sucesso — não é de onde vem o estado. */
  onSaved?: (updated: AiPrompt) => void;
}

/** "28/09/2026, 14:35" no fuso e na língua de quem olha — mesmo formato de `ClinicalLongText.tsx`. */
function formatDateTime(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(resolveDateLocale(locale), { ...SHORT_DATE_OPTIONS, hour: '2-digit', minute: '2-digit' });
}

export function AiPromptEditor({ prompt, onSaved }: AiPromptEditorProps) {
  const { t, i18n } = useTranslation();
  const ac = (k: string, o?: Record<string, unknown>) => t(`admin.aiPrompts.actions.${k}`, o);
  const ec = (k: string, o?: Record<string, unknown>) => t(`admin.aiPrompts.errors.${k}`, o);
  const dc = (k: string, o?: Record<string, unknown>) => t(`admin.aiPrompts.editor.${k}`, o);

  // A mesma célula que autoriza salvar autoriza desfazer (contrato: "a mesma de quem salvou").
  const updateGate = useActionGate('ai_prompt', 'update');

  const [current, setCurrent] = useState<AiPrompt>(prompt);
  const [body, setBody] = useState(prompt.body);

  // Reseta o rascunho SÓ quando o slug muda (troca de aba) — depois disso o estado é próprio:
  // salvar/desfazer atualizam `current`/`body` localmente, sem esperar o pai re-renderizar.
  useEffect(() => {
    setCurrent(prompt);
    setBody(prompt.body);
    setSaveError(null);
    setUndoError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt.slug]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);

  const charCount = body.length;
  // Não desabilita por texto vazio: o clique precisa CHEGAR em `handleSave` pra mostrar
  // `errors.emptyBody` — um botão já desabilitado tornaria esse erro morto (jsdom, igual ao
  // navegador, não dispara clique em elemento `disabled`).
  const canSave = !saving;
  // migration 487 semeia a versão 1 — só a partir da 2 existe conteúdo anterior pra desfazer
  // (mesma leitura de `UndoAiPromptUseCase.no_previous_version` no servidor).
  const canUndo = current.version > 1 && !undoing;

  /** 409: o corpo trai `updatedBy`, mas `ApiError` não o guarda — refaz a leitura pra mostrar quem foi. */
  const conflictMessage = async (slug: AiPromptSlug): Promise<string> => {
    try {
      const fresh = await AdminApiService.getAiPrompt(slug);
      setCurrent(fresh);
      setBody((b) => (b === current.body ? fresh.body : b)); // rascunho intocado se já havia edição
      return ec('versionConflict', { updatedBy: fresh.updatedBy ?? '—' });
    } catch {
      return ec('versionConflict', { updatedBy: '—' });
    }
  };

  const handleSave = async (): Promise<void> => {
    if (body.trim().length === 0) {
      setSaveError(ec('emptyBody'));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await AdminApiService.updateAiPrompt(current.slug, body, current.version);
      setCurrent(updated);
      setBody(updated.body);
      onSaved?.(updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSaveError(await conflictMessage(current.slug));
      } else {
        setSaveError(err instanceof Error ? err.message : ec('emptyBody'));
      }
    } finally {
      setSaving(false);
    }
  };

  // Sem guarda de `canUndo` aqui: o único chamador é o `onClick` do botão abaixo, que já nasce
  // `disabled` quando `canUndo` é falso — jsdom (igual ao navegador) não dispara clique em elemento
  // desabilitado. Checar de novo seria branch morto, nunca exercitável por um clique de verdade
  // (mesmo raciocínio de `LocalizacoesCard.onMarkPrimary`).
  const handleUndo = async (): Promise<void> => {
    if (!window.confirm(ac('undoConfirm'))) return;
    setUndoing(true);
    setUndoError(null);
    try {
      const restored = await AdminApiService.undoAiPrompt(current.slug, current.version);
      setCurrent(restored);
      setBody(restored.body);
      onSaved?.(restored);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setUndoError(await conflictMessage(current.slug));
      } else if (err instanceof ApiError && err.status === 422) {
        setUndoError(ac('undoUnavailable'));
      } else {
        setUndoError(err instanceof Error ? err.message : ac('undoUnavailable'));
      }
    } finally {
      setUndoing(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="ai-prompt-editor">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        resize="vertical"
        rows={16}
        aria-label={t('admin.aiPrompts.title')}
        data-testid="ai-prompt-editor-textarea"
      />

      <div className="flex justify-between items-center">
        {current.updatedAt ? (
          <Text as="span" size="xs" color="muted" data-testid="ai-prompt-editor-author">
            {dc('lastEditedBy', {
              date: formatDateTime(current.updatedAt, i18n.language),
              name: current.updatedBy ?? '—',
            })}
          </Text>
        ) : (
          <span />
        )}
        <Text as="span" size="xs" color="muted" data-testid="ai-prompt-editor-counter">
          {dc('charCount', { count: charCount })}
        </Text>
      </div>

      {saveError && (
        <Text size="sm" role="alert" className="text-red-600" data-testid="ai-prompt-editor-save-error">
          {saveError}
        </Text>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={!canSave}>
          {saving ? ac('saving') : ac('save')}
        </Button>

        {updateGate.allowed && (
          <div className="flex flex-col gap-1">
            <Button variant="outline" onClick={handleUndo} disabled={!canUndo}>
              {ac('undo')}
            </Button>
            {current.version <= 1 && (
              <Text as="span" size="xs" color="muted" data-testid="ai-prompt-editor-undo-reason">
                {ac('undoUnavailable')}
              </Text>
            )}
          </div>
        )}
      </div>

      {undoError && (
        <Text size="sm" role="alert" className="text-red-600" data-testid="ai-prompt-editor-undo-error">
          {undoError}
        </Text>
      )}
    </div>
  );
}
