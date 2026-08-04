/**
 * MetricCard Atom
 * Displays a metric with title, value, and optional subtitle.
 *
 * Base (title/value/subtitle) preserva o visual original usado no dashboard de
 * recrutamento. Quando `accent`/`icon` são passados, o card ganha a paleta da
 * marca Enlite: um "chip" de ícone colorido + número na cor do accent, para que
 * a categoria de cada número seja lida num relance (scan de ~1s).
 */
import type { LucideIcon } from 'lucide-react';
import { HelpCircle } from 'lucide-react';

export type MetricAccent =
  | 'neutral'
  | 'primary'
  | 'care'
  | 'clinic'
  | 'learn'
  | 'coordination'
  | 'cyan'
  | 'success';

interface MetricCardProps {
  title: string;
  value: number | string;
  subtitle?: string;
  onClick?: () => void;
  className?: string;
  /** Ícone lucide que representa a categoria do número (people, heart, clock…). */
  icon?: LucideIcon;
  /** Cor de marca aplicada ao chip do ícone e ao número. Default: neutral. */
  accent?: MetricAccent;
  /** Abre a ajuda "o que é este número" — renderiza um "?" no canto do card. */
  onHelpClick?: () => void;
  /** aria-label do botão de ajuda (obrigatório junto com onHelpClick). */
  helpAriaLabel?: string;
}

/** chip = fundo tint + ícone; value = cor legível (escurecida) do accent. */
const ACCENT_STYLES: Record<MetricAccent, { chip: string; icon: string; value: string; hover: string }> = {
  neutral: { chip: 'bg-slate-100 dark:bg-slate-700', icon: 'text-slate-500', value: 'text-slate-900 dark:text-slate-100', hover: 'hover:border-slate-300' },
  primary: { chip: 'bg-primary/10', icon: 'text-primary', value: 'text-primary dark:text-indigo-200', hover: 'hover:border-primary/40' },
  care: { chip: 'bg-[#F227AF]/12', icon: 'text-[#F227AF]', value: 'text-[#B31388] dark:text-[#F79FDA]', hover: 'hover:border-[#F227AF]/40' },
  clinic: { chip: 'bg-[#8932FD]/12', icon: 'text-[#8932FD]', value: 'text-[#6B21C7] dark:text-[#C9A6FF]', hover: 'hover:border-[#8932FD]/40' },
  learn: { chip: 'bg-[#FFB607]/16', icon: 'text-[#D98A00]', value: 'text-[#B45309] dark:text-[#FCD34D]', hover: 'hover:border-[#FFB607]/50' },
  coordination: { chip: 'bg-[#FF575C]/12', icon: 'text-[#FF575C]', value: 'text-[#D42B30] dark:text-[#FF9A9D]', hover: 'hover:border-[#FF575C]/40' },
  cyan: { chip: 'bg-[#06ADDD]/12', icon: 'text-[#06ADDD]', value: 'text-[#0E7C9E] dark:text-[#7DD3F0]', hover: 'hover:border-[#06ADDD]/40' },
  success: { chip: 'bg-[#10B981]/12', icon: 'text-[#10B981]', value: 'text-[#0F766E] dark:text-[#6EE7B7]', hover: 'hover:border-[#10B981]/40' },
};

export function MetricCard({
  title,
  value,
  subtitle,
  onClick,
  className = '',
  icon: Icon,
  accent,
  onHelpClick,
  helpAriaLabel,
}: MetricCardProps): JSX.Element {
  const isClickable = !!onClick;
  const styled = !!accent || !!Icon;
  const a = ACCENT_STYLES[accent ?? 'neutral'];

  return (
    <div
      onClick={onClick}
      className={`relative bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col gap-3 transition-all duration-200 ${
        isClickable ? `cursor-pointer hover:shadow-md ${styled ? a.hover : 'hover:border-primary'}` : ''
      } ${className}`}
    >
      {onHelpClick && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onHelpClick();
          }}
          aria-label={helpAriaLabel}
          title={helpAriaLabel}
          data-testid="metric-help"
          className="absolute top-3 right-3 rounded-full p-1.5 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-200"
        >
          <HelpCircle className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      <div className="flex items-start gap-4">
        {Icon && (
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${a.chip}`}>
            <Icon className={`h-5 w-5 ${a.icon}`} aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400 mb-1">{title}</p>
          <h4 className={`text-3xl font-bold ${styled ? a.value : 'text-slate-900 dark:text-slate-100'}`}>{value}</h4>
        </div>
      </div>
      {subtitle && (
        <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
      )}
    </div>
  );
}
