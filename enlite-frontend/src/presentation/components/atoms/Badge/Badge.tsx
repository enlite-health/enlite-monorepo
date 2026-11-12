import type { StepStatus } from '../../../../types/workerProgress';

/**
 * Tons de texto livre (089 T024), para selos como "Documentos completos" / "Ya en 1 caso".
 * Razões de contraste (WCAG, sRGB→linear): neutral 17,20 · brand 15,31 · success 7,80 · warning 9,21 — todos AAA.
 * ⚠️ `success` NÃO é `#0B5E45` (6,89:1, falha AAA): o texto é `#0A5540`.
 * Os tons de `status` (icon-only) abaixo ficam como estão: green-700/green-50 = 4,79 e amber-700/amber-50 = 4,84.
 */
export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning';

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-gray-200 text-primary',
  brand: 'bg-[#ECE8F6] text-primary',
  success: 'bg-[#E1F6EE] text-[#0A5540]',
  warning: 'bg-[#FFF4D6] text-[#5C3B00]',
};

type BadgeProps = (
  | { status: StepStatus; tone?: never; children?: never }
  | { tone: BadgeTone; children: React.ReactNode; status?: never }
) & {
  size?: 'sm' | 'md';
  className?: string;
};

const statusConfig: Record<StepStatus, { icon: string; color: string; bgColor: string }> = {
  completed: {
    icon: '✅',
    color: 'text-green-700',
    bgColor: 'bg-green-50',
  },
  pending: {
    icon: '⚠️',
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
  },
  locked: {
    icon: '🔒',
    color: 'text-gray-600',
    bgColor: 'bg-gray-100',
  },
};

const sizeClasses = {
  sm: 'text-sm px-2 py-0.5',
  md: 'text-base px-3 py-1',
};

export const Badge = (props: BadgeProps): JSX.Element => {
  const { size = 'sm', className = '' } = props;

  if (props.tone) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full font-lexend text-xs font-medium px-2.5 py-0.5 ${toneClasses[props.tone]} ${className}`}
      >
        {props.children}
      </span>
    );
  }

  const config = statusConfig[props.status];

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-lexend font-medium ${config.color} ${config.bgColor} ${sizeClasses[size]} ${className}`}
    >
      <span>{config.icon}</span>
    </span>
  );
};
