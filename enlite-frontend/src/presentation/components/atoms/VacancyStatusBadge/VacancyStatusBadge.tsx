import { useTranslation } from 'react-i18next';

interface VacancyStatusBadgeProps {
  status: string;
  className?: string;
}

interface BadgeConfig {
  labelKey: string;
  bgClass: string;
  // Text color paired with bgClass for WCAG-AA contrast. Light/bright backgrounds
  // (amber #FFC53B, cyan #06ADDD) fail with white text, so they use dark text.
  textClass: string;
}

const WHITE = 'text-white';
const DARK = 'text-primary';

const STATUS_CONFIG: Record<string, BadgeConfig> = {
  // ── Canonical statuses (migrations 148 + 166) ─────────────────────────────
  SEARCHING: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING',
    bgClass: 'bg-blue-yonder',
    textClass: WHITE,
  },
  SEARCHING_REPLACEMENT: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING_REPLACEMENT',
    bgClass: 'bg-wait',
    textClass: DARK,
  },
  RAPID_RESPONSE: {
    labelKey: 'admin.vacancyDetail.statusBadge.RAPID_RESPONSE',
    bgClass: 'bg-wait',
    textClass: DARK,
  },
  PENDING_ACTIVATION: {
    labelKey: 'admin.vacancyDetail.statusBadge.PENDING_ACTIVATION',
    bgClass: 'bg-cyan-focus',
    textClass: DARK,
  },
  ACTIVE: {
    labelKey: 'admin.vacancyDetail.statusBadge.ACTIVE',
    bgClass: 'bg-blue-yonder',
    textClass: WHITE,
  },
  ON_HOLD: {
    labelKey: 'admin.vacancyDetail.statusBadge.ON_HOLD',
    bgClass: 'bg-wait',
    textClass: DARK,
  },
  SUSPENDED: {
    labelKey: 'admin.vacancyDetail.statusBadge.SUSPENDED',
    bgClass: 'bg-gray-800',
    textClass: WHITE,
  },
  CLOSED: {
    labelKey: 'admin.vacancyDetail.statusBadge.CLOSED',
    bgClass: 'bg-gray-800',
    textClass: WHITE,
  },
  // ── Patient-level status surfaced on the same badge ───────────────────────
  ADMISSION: {
    labelKey: 'admin.vacancyDetail.statusBadge.ADMISSION',
    bgClass: 'bg-cyan-focus',
    textClass: DARK,
  },
  // ── Legacy aliases (kept for backward compatibility, pre-migration 148) ───
  BUSQUEDA: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING',
    bgClass: 'bg-blue-yonder',
    textClass: WHITE,
  },
  ACTIVO: {
    labelKey: 'admin.vacancyDetail.statusBadge.ACTIVE',
    bgClass: 'bg-blue-yonder',
    textClass: WHITE,
  },
  REEMPLAZOS: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING_REPLACEMENT',
    bgClass: 'bg-wait',
    textClass: DARK,
  },
  REEMPLAZO: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING_REPLACEMENT',
    bgClass: 'bg-wait',
    textClass: DARK,
  },
  PAUSADO: {
    labelKey: 'admin.vacancyDetail.statusBadge.ON_HOLD',
    bgClass: 'bg-wait',
    textClass: DARK,
  },
  CERRADO: {
    labelKey: 'admin.vacancyDetail.statusBadge.CLOSED',
    bgClass: 'bg-gray-800',
    textClass: WHITE,
  },
};

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export function VacancyStatusBadge({
  status,
  className = '',
}: VacancyStatusBadgeProps): JSX.Element {
  const { t } = useTranslation();
  const normalizedStatus = status?.toUpperCase() ?? '';
  const config = STATUS_CONFIG[normalizedStatus];

  const bgClass = config?.bgClass ?? 'bg-gray-800';
  const textClass = config?.textClass ?? WHITE;
  const label = config ? t(config.labelKey) : capitalize(status ?? '');

  return (
    <span
      className={`inline-flex items-center justify-center font-poppins font-semibold text-xs px-6 py-1 rounded ${bgClass} ${textClass} ${className}`}
    >
      {label}
    </span>
  );
}
