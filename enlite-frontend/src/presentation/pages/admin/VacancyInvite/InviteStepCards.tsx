import { useTranslation } from 'react-i18next';
import { CircleCheck } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { StepId, StepSummary, StepTone } from './inviteBoardModel';

// ⚑8: texto verde do concluído = #0A5540 sobre #E1F6EE (7,80:1); o canvas tinha #0B5E45 (6,89:1).
const TONE_CLASS: Record<StepTone, string> = {
  current: 'border-2 border-primary bg-[#ECE8F6] text-primary',
  done: 'border border-[#B7E4D2] bg-[#E1F6EE] text-[#0A5540]',
  'pending-vacante': 'border border-[#F0D58A] bg-[#FFF4D6] text-[#5C3B00]',
  idle: 'border border-gray-600 bg-white text-primary',
};

interface Props {
  steps: readonly StepSummary[];
  onSelect: (step: StepId) => void;
}

/** B.4 — cartões de passo (Ya en la vacante + 4 faixas). */
export function InviteStepCards({ steps, onSelect }: Props): JSX.Element {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t('admin.vacancyInvite.steps.label')} data-testid="invite-step-cards" className="flex gap-2">
      {steps.filter((s) => s.visible).map((s) => (
        <button
          key={s.step}
          type="button"
          data-testid={`invite-step-${s.step}`}
          data-tone={s.tone}
          aria-current={s.isCurrent ? 'step' : undefined}
          onClick={() => onSelect(s.step)}
          className={`h-[72px] flex-auto rounded-2xl px-2.5 py-2.5 text-left ${TONE_CLASS[s.tone]}`}
        >
          <Heading level={4} as="h3" weight="semibold" color="inherit" className="flex items-center gap-1 truncate !text-sm !leading-5">
            {s.step === 'vacante'
              ? t('admin.vacancyInvite.steps.vacante')
              : t('admin.vacancyInvite.steps.upTo', { km: s.band?.max })}
            {s.completed && <CircleCheck size={16} aria-hidden="true" />}
          </Heading>
          <Text size="xs" color="inherit" className="truncate">
            {t(`admin.vacancyInvite.steps.sub.${s.sub.key}`, { count: s.sub.count })}
          </Text>
        </button>
      ))}
    </div>
  );
}
