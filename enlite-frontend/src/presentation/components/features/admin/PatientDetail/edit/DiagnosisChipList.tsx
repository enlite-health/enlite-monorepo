/**
 * DiagnosisChipList — chips dos diagnósticos escolhidos, dentro do drawer clínico (spec 016 F3).
 *
 * 🔴 REQ-21 — cada chip mostra SÓ `d.title` (a patología, em espanhol, como veio da OMS — nunca
 * traduzida por nós, cláusula 1.2.3). `d.uri`/código NUNCA entram no DOM: nem texto, nem
 * `title=`, nem `aria-label`, nem `data-*`. O corpo do chip promove a principal; o X pede
 * confirmação inline antes de remover (`active:false` no servidor — sem DELETE físico).
 *
 * Auditoria UX (specs/016-admissao-cid11/evidencias/ux): U3 — o X removia sem confirmação, colado
 * na estrela (mis-clique apaga diagnóstico). U4 — o botão de promover era só ícone com
 * `aria-label`, sem texto visível, e o corpo do chip não reagia ao clique.
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
      <Text as="span" size="xs" color="muted" data-testid="diagnosis-chips-empty">
        {ta('chipsEmpty')}
      </Text>
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="diagnosis-chips">
      {diagnoses.map((d) => {
        const isBusy = busyId === d.id;
        const clickableToPromote = !d.isPrimary && !isBusy;
        const isConfirmingRemove = confirmRemoveId === d.id;
        return (
          <li
            key={d.id}
            onClick={() => { if (clickableToPromote) onPromote(d.id); }}
            className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border ${
              d.isPrimary ? 'border-primary bg-primary/5' : 'border-slate-200'
            } ${clickableToPromote ? 'cursor-pointer' : ''}`}
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
              <Text as="span" size="sm" weight="medium" className="truncate">
                {d.title}
              </Text>
            </div>
            {isConfirmingRemove ? (
              <div
                className="flex items-center gap-2 shrink-0"
                data-testid={`diagnosis-chip-remove-confirm-${d.id}`}
              >
                <Text as="span" size="2xs" className="!text-red-600">
                  {ta('removeConfirmQuestion')}
                </Text>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmRemoveId(null); }}
                  className="text-slate-500 hover:text-slate-700 transition-colors"
                  data-testid={`diagnosis-chip-remove-cancel-${d.id}`}
                >
                  <Text as="span" size="2xs" color="inherit">{ta('removeCancel')}</Text>
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmRemoveId(null); onRemove(d.id); }}
                  className="text-red-600 hover:text-red-700 transition-colors"
                  data-testid={`diagnosis-chip-remove-confirm-btn-${d.id}`}
                >
                  <Text as="span" size="2xs" color="inherit">{ta('remove')}</Text>
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
                    className="flex items-center gap-1 text-slate-400 hover:text-primary transition-colors disabled:opacity-50"
                    data-testid={`diagnosis-chip-promote-${d.id}`}
                  >
                    <Star className="w-4 h-4" />
                    <Text as="span" size="2xs" color="inherit">{ta('makePrimary')}</Text>
                  </button>
                )}
                {/* U3: separador visual entre estrela e X — mis-clique era o próprio achado da auditoria */}
                <span className="w-px h-4 bg-slate-200" aria-hidden="true" />
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setConfirmRemoveId(d.id); }}
                  disabled={isBusy}
                  aria-label={ta('remove')}
                  className="text-slate-400 hover:text-red-600 transition-colors disabled:opacity-50"
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
