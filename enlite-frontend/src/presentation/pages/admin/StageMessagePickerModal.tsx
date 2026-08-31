/**
 * StageMessagePickerModal — escolher a mensagem de uma etapa do Kanban VENDO o
 * texto antes de ligar.
 *
 * Por que não é mais um `<select>`: o rótulo da opção era o slug
 * (`ar_finalize_signup_luz`), e `message_templates.name` é IGUAL ao slug nas 27
 * linhas de produção — o sync escreve `friendly_name` da Twilio nos dois. Nome
 * amigável não existe em lugar nenhum, então quem escolhe não tem como saber o
 * que vai sair. Aqui a identidade da opção é o começo do próprio texto.
 *
 * A prévia mostra SÓ `bodyTwilio` — o texto que a Meta aprovou. Nunca `body`:
 * ele é o contrato de ENVIO (a ordem dos nomes), e uma conferência de 31/08
 * contra a Content API achou 12 de 27 templates com `body` divergindo do texto
 * aprovado, de ponteiro a cópia velha. Enquanto a prévia depender só do texto
 * aprovado, sentinela nenhum — inclusive os que ainda não existem — tem por onde
 * chegar à tela, e não é preciso filtro reconhecendo literais. Sem texto
 * aprovado, a tela diz que não sabe.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { FunnelStageTemplateOption } from '@infrastructure/http/AdminFunnelStageMessagesApiService';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { SEARCH_THRESHOLD, previewTextOf, summaryOf } from './stageMessagePreview';

interface Props {
  stageLabel: string;
  templates: FunnelStageTemplateOption[];
  initialSlug: string;
  initialEnabled: boolean;
  saving: boolean;
  /** false = staff não-admin: pode LER a mensagem, não pode gravar (lex C7). */
  canSave: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (slug: string, enabled: boolean) => void;
}

export function StageMessagePickerModal({ stageLabel, templates, initialSlug, initialEnabled, saving, canSave, error, onCancel, onConfirm }: Props): JSX.Element {
  const { t } = useTranslation();
  const [slug, setSlug] = useState(initialSlug);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const eligible = useMemo(() => templates.filter((tp) => tp.eligible), [templates]);
  const blocked = useMemo(() => templates.filter((tp) => !tp.eligible), [templates]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((tp) => `${tp.slug} ${summaryOf(tp) ?? ''}`.toLowerCase().includes(q));
  }, [eligible, query]);

  // Agrupar por motivo bate busca em n=24: a pergunta é "por que X não está aqui".
  const blockedByReason = useMemo(() => {
    const map = new Map<string, FunnelStageTemplateOption[]>();
    for (const tp of blocked) {
      const key = tp.reason ?? 'PLACEHOLDERS';
      map.set(key, [...(map.get(key) ?? []), tp]);
    }
    return [...map.entries()];
  }, [blocked]);

  const selected = eligible.find((tp) => tp.slug === slug) ?? null;
  const preview = selected ? previewTextOf(selected) : null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-primary/40" onClick={onCancel} data-testid="fsm-modal-backdrop" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={t('admin.funnelStageMessages.picker.title', { stage: stageLabel })}
          data-testid="fsm-modal"
          className="pointer-events-auto flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-card-lg bg-white shadow-extra-large outline-none"
        >
          <div className="flex items-start justify-between gap-4 border-b border-gray-300 px-6 py-4">
            <div>
              <Heading level={2} weight="semibold" color="primary">{t('admin.funnelStageMessages.picker.title', { stage: stageLabel })}</Heading>
              <Text size="xs" color="secondary">{t('admin.funnelStageMessages.eligibleHint')}</Text>
            </div>
            <button type="button" onClick={onCancel} aria-label={t('admin.funnelStageMessages.picker.close')} className="rounded p-1 text-gray-800 hover:text-primary">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-2">
            {/* Esquerda: o que dá para escolher */}
            <div className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto border-b border-gray-300 p-4 md:border-b-0 md:border-r">
              {eligible.length > SEARCH_THRESHOLD && (
                <input
                  type="search"
                  data-testid="fsm-modal-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('admin.funnelStageMessages.picker.search')}
                  aria-label={t('admin.funnelStageMessages.picker.search')}
                  className="w-full rounded-input border border-gray-600 px-3 py-2 outline-none focus:border-primary focus:ring-2 focus:ring-primary"
                />
              )}
              <Text size="xs" color="secondary" className="uppercase tracking-wider">{t('admin.funnelStageMessages.picker.eligibleGroup', { count: eligible.length })}</Text>

              {shown.length === 0 && (
                <div data-testid="fsm-modal-empty"><Text size="sm" color="secondary">{t('admin.funnelStageMessages.picker.noMatch')}</Text></div>
              )}

              {shown.map((tp) => {
                const summary = summaryOf(tp);
                const isSel = tp.slug === slug;
                return (
                  <button
                    key={tp.slug}
                    type="button"
                    aria-pressed={isSel}
                    data-testid={`fsm-option-${tp.slug}`}
                    disabled={!canSave}
                    onClick={() => setSlug(isSel ? '' : tp.slug)}
                    className={`flex flex-col gap-0.5 rounded-input border p-3 text-left ${isSel ? 'border-clinic ring-1 ring-clinic bg-gray-100' : 'border-gray-600 hover:border-clinic'}`}
                  >
                    <Text size="sm" weight="medium" color="primary" className="line-clamp-2">
                      {summary ? `«${summary.slice(0, 70)}${summary.length > 70 ? '…' : ''}»` : t('admin.funnelStageMessages.picker.noText')}
                    </Text>
                    <Text size="xs" color="secondary">{tp.slug}</Text>
                  </button>
                );
              })}

              {blocked.length > 0 && (
                <div className="mt-3 flex flex-col gap-2" data-testid="fsm-blocked-list">
                  {/* Sempre visível, agrupado por motivo: a pergunta de quem procura
                      não é "cadê o template X", é "por que o X não está aqui". Era um
                      toggle e ficava abaixo da dobra da coluna — abria sem parecer que
                      abriu. */}
                  <Text size="xs" color="secondary" className="uppercase tracking-wider">{t('admin.funnelStageMessages.picker.blockedGroup', { count: blocked.length })}</Text>
                  {blockedByReason.map(([reason, list]) => (
                    <div key={reason} data-testid={`fsm-blocked-${reason}`} className="rounded-input border border-gray-300 bg-gray-200 p-3">
                      <Text size="xs" weight="medium" color="primary">{t(`admin.funnelStageMessages.ineligible.${reason}`)} ({list.length})</Text>
                      <Text size="xs" color="secondary">{list.map((tp) => tp.slug).join(' · ')}</Text>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Direita: o que a cuidadora recebe */}
            <div className="flex max-h-[28rem] flex-col gap-2 overflow-y-auto bg-gray-100 p-4">
              <Text size="xs" color="secondary" className="uppercase tracking-wider">{t('admin.funnelStageMessages.picker.previewLabel')}</Text>
              {!selected && <div data-testid="fsm-preview-none"><Text size="sm" color="secondary">{t('admin.funnelStageMessages.picker.pickToPreview')}</Text></div>}
              {selected && preview && (
                <>
                  <div data-testid="fsm-preview" className="whitespace-pre-wrap rounded-image bg-white p-4 shadow-small"><Text size="sm" color="primary" className="whitespace-pre-wrap">{preview}</Text></div>
                  <Text size="xs" color="secondary">{t('admin.funnelStageMessages.picker.sampleNote')}</Text>
                </>
              )}
              {selected && !preview && (
                <div data-testid="fsm-preview-unsynced" className="rounded-image border border-wait bg-learn/10 p-4">
                  <Text size="sm" color="inherit" className="text-amber-900">{t('admin.funnelStageMessages.picker.unsynced')}</Text>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-300 px-6 py-4">
            <label className="flex items-center gap-2">
              <Checkbox data-testid="fsm-modal-enabled" checked={enabled} disabled={!slug || !canSave} onChange={(e) => setEnabled(e.target.checked)} aria-label={t('admin.funnelStageMessages.picker.activate')} />
              <Text size="sm" color="secondary">{t('admin.funnelStageMessages.picker.activate')}</Text>
            </label>
            <div className="flex items-center gap-2">
              {error && <span className="text-pink-cancel" data-testid="fsm-modal-error"><Text as="span" size="xs" color="inherit">{error}</Text></span>}
              <Button variant="outline" size="sm" onClick={onCancel} data-testid="fsm-modal-cancel">{t('admin.funnelStageMessages.picker.cancel')}</Button>
              <Button variant="primary" size="sm" disabled={saving || !canSave} onClick={() => onConfirm(slug, enabled && !!slug)} data-testid="fsm-modal-save">
                {saving ? t('admin.funnelStageMessages.saving') : t('admin.funnelStageMessages.save')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
