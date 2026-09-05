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
 * Visual (05/09): o chip tem a MESMA caixa do input de busca logo acima (48px mínimos, raio 10px,
 * borda 1,5px #d9d9d9) — era o terceiro estilo de caixa na mesma coluna. Ações em `xs` (12px), não
 * `2xs` (11px): são botões que apagam/promovem diagnóstico, precisam ser lidos.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Star, X } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientDiagnosisDetail } from '@domain/entities/PatientDetail';

export interface DiagnosisChipListProps {
  diagnoses: PatientDiagnosisDetail[];
  busyId?: string | null;
  onPromote: (id: string) => void;
  onRemove: (id: string) => void;
}

export function DiagnosisChipList({
  diagnoses,
  busyId = null,
  onPromote,
  onRemove,
}: DiagnosisChipListProps): JSX.Element {
  const { t } = useTranslation();
  const ta = (k: string) => t(`admin.patients.editDrawer.diagnosisAssignment.${k}`);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  if (diagnoses.length === 0) {
    return (
      <Text as="span" size="xs" color="secondary" data-testid="diagnosis-chips-empty">
        {ta('chipsEmpty')}
      </Text>
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="diagnosis-chips">
      {diagnoses.map((d) => {
        const isBusy = busyId === d.id;
        const isConfirmingRemove = confirmRemoveId === d.id;
        return (
          <li
            key={d.id}
            className={`flex items-center justify-between gap-3 px-4 min-h-12 py-2 rounded-[10px] border-[1.5px] ${
              d.isPrimary ? 'border-primary bg-primary/5' : 'border-[#d9d9d9]'
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
            {isConfirmingRemove ? (
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
                  className="text-[#737373] hover:text-primary transition-colors"
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
                    disabled={isBusy}
                    aria-label={ta('makePrimary')}
                    className="flex items-center gap-1 text-[#737373] hover:text-primary transition-colors disabled:opacity-50"
                    data-testid={`diagnosis-chip-promote-${d.id}`}
                  >
                    <Star className="w-4 h-4" />
                    <Text as="span" size="xs" color="inherit">{ta('makePrimary')}</Text>
                  </button>
                )}
                {/* U3: separador visual entre estrela e X — mis-clique era o próprio achado da auditoria */}
                <span className="w-px h-4 bg-[#d9d9d9]" aria-hidden="true" />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmRemoveId(d.id); }}
                  disabled={isBusy}
                  aria-label={ta('remove')}
                  className="text-[#737373] hover:text-red-600 transition-colors disabled:opacity-50"
                  data-testid={`diagnosis-chip-remove-${d.id}`}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
