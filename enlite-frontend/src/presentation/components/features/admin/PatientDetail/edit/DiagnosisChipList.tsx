/**
 * DiagnosisChipList — chips dos diagnósticos escolhidos, dentro do drawer clínico (spec 016 F3).
 *
 * 🔴 REQ-21 — cada chip mostra SÓ `d.title` (a patología, em espanhol, como veio da OMS — nunca
 * traduzida por nós, cláusula 1.2.3). `d.uri`/código NUNCA entram no DOM: nem texto, nem
 * `title=`, nem `aria-label`, nem `data-*`. Promover e remover são ações só dos BOTÕES — o corpo
 * do chip é inerte (V2/rodada 2); o X pede confirmação inline antes de remover (`active:false` no
 * servidor — sem DELETE físico).
 *
 * Auditoria UX (specs/016-admissao-cid11/evidencias/ux): U3 — o X removia sem confirmação, colado
 * na estrela (mis-clique apaga diagnóstico). U4 — o botão de promover era só ícone com
 * `aria-label`, sem texto visível (resolvido deixando o texto sempre visível no botão).
 *
 * V2 (rodada 2, item 8c) — o conserto do U4 tinha tornado o CORPO do chip inteiro clicável para
 * promover. Medido: um clique a 8px do botão de remover (fora da hitbox dele) caiu no corpo do
 * chip e disparou `PATCH {isPrimary:true}` em vez de `{active:false}` — o badge "Principal" migra
 * de chip sem nenhum aviso. O corpo voltou a não fazer nada; promover só pelo botão com texto
 * visível (já resolvia a descoberta, medido na 2ª auditoria, item 8: ENTENDE).
 *
 * Visual (05/09): o chip usa a MESMA geometria do input de busca logo acima — raio, borda e padding
 * vêm de `INPUT_SIZE_CONFIG.compact` (fonte única em `atoms/Input/inputClasses.ts`) — era o terceiro
 * estilo de caixa na mesma coluna. NÃO usa `inputWrapperClasses`: ele traz `focus-within` na cor
 * primária, que é exatamente a borda do chip Principal (tabular até o X de um chip comum o pintava
 * como principal), e `h-12` fixo, que espremia o título quando a confirmação de remoção aparece —
 * aqui é altura MÍNIMA. Ações em `xs` (12px), não `2xs`: são botões que apagam/promovem diagnóstico.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, X } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientDiagnosisDetail } from '@domain/entities/PatientDetail';
import { INPUT_SIZE_CONFIG } from '@presentation/components/atoms/Input/inputClasses';

/** Ação em voo num chip: o chip troca os botões por spinner + "Guardando…"/"Quitando…" (06/09, Gabriel). */
export interface ChipBusy { id: string; action: 'promote' | 'remove' }

export interface DiagnosisChipListProps {
  diagnoses: PatientDiagnosisDetail[];
  busy?: ChipBusy | null;
  /** Título do diagnóstico que está sendo GRAVADO agora (POST em voo) — vira chip provisório "Agregando…". */
  pendingTitle?: string | null;
  onPromote: (id: string) => void;
  onRemove: (id: string) => void;
}

export function DiagnosisChipList({
  diagnoses,
  busy = null,
  pendingTitle = null,
  onPromote,
  onRemove,
}: DiagnosisChipListProps): JSX.Element {
  const { t } = useTranslation();
  const ta = (k: string) => t(`admin.patients.editDrawer.diagnosisAssignment.${k}`);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  // Chip provisório: mesma caixa dos chips reais, título já visível, spinner + "Agregando…" no lugar
  // das ações. `aria-busy` + `role="status"` para o leitor de tela anunciar que algo está acontecendo.
  const pendingChip = pendingTitle !== null && (
    <li
      role="status"
      aria-busy="true"
      className={`flex items-center justify-between gap-3 min-h-12 border-solid border-dashed ${INPUT_SIZE_CONFIG.compact.padding} ${INPUT_SIZE_CONFIG.compact.borderRadius} ${INPUT_SIZE_CONFIG.compact.borderWidth} border-gray-600 bg-gray-200`}
      data-testid="diagnosis-chip-pending"
    >
      <Text as="span" size="sm" weight="medium" color="secondary" className="truncate">
        {pendingTitle}
      </Text>
      <span className="flex items-center gap-2 shrink-0">
        <span className="block w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" aria-hidden="true" />
        <Text as="span" size="xs" color="secondary">{ta('adding')}</Text>
      </span>
    </li>
  );

  if (diagnoses.length === 0 && pendingTitle === null) {
    return (
      <Text as="span" size="xs" color="secondary" data-testid="diagnosis-chips-empty">
        {ta('chipsEmpty')}
      </Text>
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="diagnosis-chips">
      {diagnoses.map((d) => {
        const isBusy = busy?.id === d.id;
        const isConfirmingRemove = confirmRemoveId === d.id && !isBusy;
        return (
          <li
            key={d.id}
            className={`flex items-center justify-between gap-3 min-h-12 border-solid ${INPUT_SIZE_CONFIG.compact.padding} ${INPUT_SIZE_CONFIG.compact.borderRadius} ${INPUT_SIZE_CONFIG.compact.borderWidth} ${
              d.isPrimary ? 'border-primary bg-primary/5' : 'border-gray-600 bg-white'
            }`}
            data-testid={`diagnosis-chip-${d.id}`}
          >
            <div className="flex items-center gap-2 min-w-0">
              {d.isPrimary && (
                <span
                  className="shrink-0 bg-primary/10 text-primary px-1.5 py-0.5 rounded-full"
                  data-testid={`diagnosis-chip-primary-badge-${d.id}`}
                >
                  <Text as="span" size="2xs" weight="medium" color="inherit">
                    {ta('primaryBadge')}
                  </Text>
                </span>
              )}
              <Text as="span" size="sm" weight="medium" color="tertiary" className="truncate">
                {d.title}
              </Text>
            </div>
            {isBusy ? (
              <span
                className="flex items-center gap-2 shrink-0"
                role="status"
                aria-busy="true"
                data-testid={`diagnosis-chip-busy-${d.id}`}
              >
                <span className="block w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" aria-hidden="true" />
                <Text as="span" size="xs" color="secondary">{ta(busy?.action === 'remove' ? 'removing' : 'saving')}</Text>
              </span>
            ) : isConfirmingRemove ? (
              <div
                className="flex items-center gap-2 shrink-0"
                data-testid={`diagnosis-chip-remove-confirm-${d.id}`}
              >
                <Text as="span" size="xs" className="!text-red-600">
                  {ta('removeConfirmQuestion')}
                </Text>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmRemoveId(null); }}
                  className="text-gray-800 hover:text-primary transition-colors"
                  data-testid={`diagnosis-chip-remove-cancel-${d.id}`}
                >
                  <Text as="span" size="xs" color="inherit">{ta('removeCancel')}</Text>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmRemoveId(null); onRemove(d.id); }}
                  className="text-red-600 hover:text-red-700 transition-colors"
                  data-testid={`diagnosis-chip-remove-confirm-btn-${d.id}`}
                >
                  <Text as="span" size="xs" color="inherit">{ta('remove')}</Text>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-3 shrink-0">
                {!d.isPrimary && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onPromote(d.id); }}
                    aria-label={ta('makePrimary')}
                    className="flex items-center gap-1 text-gray-800 hover:text-primary transition-colors"
                    data-testid={`diagnosis-chip-promote-${d.id}`}
                  >
                    <Star className="w-4 h-4" />
                    <Text as="span" size="xs" color="inherit">{ta('makePrimary')}</Text>
                  </button>
                )}
                {/* U3: separador visual entre estrela e X — mis-clique era o próprio achado da auditoria */}
                <span className="w-px h-4 bg-gray-600" aria-hidden="true" />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmRemoveId(d.id); }}
                  aria-label={ta('remove')}
                  className="text-gray-800 hover:text-red-600 transition-colors"
                  data-testid={`diagnosis-chip-remove-${d.id}`}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
          </li>
        );
      })}
      {pendingChip}
    </ul>
  );
}
