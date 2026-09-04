/**
 * DiagnosisChipList — chips dos diagnósticos escolhidos, dentro do drawer clínico (spec 016 F3).
 *
 * 🔴 REQ-21 — cada chip mostra SÓ `d.title` (a patología, em espanhol, como veio da OMS — nunca
 * traduzida por nós, cláusula 1.2.3). `d.uri`/código NUNCA entram no DOM: nem texto, nem
 * `title=`, nem `aria-label`, nem `data-*`. Um clique promove a principal; outro remove
 * (`active:false` no servidor — sem DELETE físico).
 */
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

  if (diagnoses.length === 0) {
    return (
      <Text as="span" size="xs" color="muted" data-testid="diagnosis-chips-empty">
        {ta('chipsEmpty')}
      </Text>
    );
  }

  return (
    <ul className="flex flex-col gap-2" data-testid="diagnosis-chips">
      {diagnoses.map((d) => (
        <li
          key={d.id}
          className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border ${
            d.isPrimary ? 'border-primary bg-primary/5' : 'border-slate-200'
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
            <Text as="span" size="sm" weight="medium" className="truncate">
              {d.title}
            </Text>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!d.isPrimary && (
              <button
                type="button"
                onClick={() => onPromote(d.id)}
                disabled={busyId === d.id}
                aria-label={ta('makePrimary')}
                className="text-slate-400 hover:text-primary transition-colors disabled:opacity-50"
                data-testid={`diagnosis-chip-promote-${d.id}`}
              >
                <Star className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => onRemove(d.id)}
              disabled={busyId === d.id}
              aria-label={ta('remove')}
              className="text-slate-400 hover:text-red-600 transition-colors disabled:opacity-50"
              data-testid={`diagnosis-chip-remove-${d.id}`}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
