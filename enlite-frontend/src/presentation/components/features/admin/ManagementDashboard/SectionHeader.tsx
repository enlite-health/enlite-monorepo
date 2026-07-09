import type { LucideIcon } from 'lucide-react';
import { Heading, Text } from '@presentation/components/atoms';
import type { MetricAccent } from '@presentation/components/atoms';

/** chip tint por accent — mesmo vocabulário de cor do MetricCard. */
const CHIP: Record<MetricAccent, string> = {
  neutral: 'bg-slate-100 text-slate-500 dark:bg-slate-700',
  primary: 'bg-primary/10 text-primary',
  care: 'bg-[#F227AF]/12 text-[#F227AF]',
  clinic: 'bg-[#8932FD]/12 text-[#8932FD]',
  learn: 'bg-[#FFB607]/16 text-[#D98A00]',
  coordination: 'bg-[#FF575C]/12 text-[#FF575C]',
  cyan: 'bg-[#06ADDD]/12 text-[#06ADDD]',
  success: 'bg-[#10B981]/12 text-[#10B981]',
};

/**
 * Cabeçalho de seção do dashboard: ícone colorido + título + linha de dica
 * em linguagem simples ("o que essa seção mostra"), para leitura de relance.
 */
export function SectionHeader({
  icon: Icon,
  title,
  hint,
  accent = 'primary',
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  accent?: MetricAccent;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${CHIP[accent]}`}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div>
        <Heading level={2} weight="semibold">
          {title}
        </Heading>
        {hint && (
          <Text as="p" size="sm" className="text-slate-500 dark:text-slate-400">
            {hint}
          </Text>
        )}
      </div>
    </div>
  );
}
