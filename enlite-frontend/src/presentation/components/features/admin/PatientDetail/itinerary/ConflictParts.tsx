import { useTranslation } from 'react-i18next';
import { TriangleAlert } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import type { PreviewConflict } from '@domain/entities/SubstitutionRequest';
import { weekdayName } from '../substitutionDates';
import { endTimeOf } from './substitutionLabels';

/** O estado de um (pessoa × turno) na tela: os 3 da pré-visão + `checking` (a pré-visão ainda não respondeu — bloqueia como `unknown`). */
export type ConflictBadgeState = 'free' | 'conflict' | 'unknown' | 'checking';

/** Cores do mockup (`.badge`): âmbar #FFE7B0/#4A2F00 (10,2:1) para conflito; verde #D3F0DF/#064E24 para livre; cinza #E8E8E8/#374151 para o resto. */
const TONE: Record<ConflictBadgeState, string> = {
  conflict: 'bg-[#FFE7B0] text-[#4A2F00]',
  free: 'bg-[#D3F0DF] text-[#064E24]',
  unknown: 'bg-[#FFE0E5] text-[#7A0A1E]',
  checking: 'bg-[#E8E8E8] text-[#374151]',
};

export function ConflictBadge({ state, testId }: { state: ConflictBadgeState; testId: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex h-[26px] items-center whitespace-nowrap rounded-full px-3 ${TONE[state]}`} data-testid={testId} data-state={state}>
      <Text as="span" size="xs" weight="semibold" color="inherit">
        {t(`admin.patients.detail.itinerary.flow.states.${state}`)}
      </Text>
    </span>
  );
}

/** "Martín ya atiende a otro paciente el lunes de 10:00 a 14:00." — o horário que colide vem do banco (dia, início, duração); a tela só o escreve. */
export function ConflictNote({ conflict, name, testId }: { conflict: PreviewConflict; name: string; testId: string }): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const overlap = conflict.overlaps[0];
  if (overlap === undefined) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border-[1.5px] border-[#D99A1B] bg-[#FFF1D1] px-3 py-2.5 text-[#4A2F00]" role="alert" data-testid={testId}>
      <TriangleAlert size={18} className="shrink-0 text-[#8A5200]" aria-hidden="true" />
      <Text as="span" size="sm" color="inherit">
        {t('admin.patients.detail.itinerary.flow.whoCovers.conflict', {
          name: name.split(' ')[0],
          weekday: weekdayName(overlap.weekday, i18n.language),
          start: overlap.startTime,
          end: endTimeOf(overlap.startTime, overlap.durationMinutes),
        })}
      </Text>
    </div>
  );
}
