import { useTranslation } from 'react-i18next';

interface VacancyStatusBadgeProps {
  status: string;
  className?: string;
}

interface BadgeConfig {
  labelKey: string;
  bgClass: string;
}

const STATUS_CONFIG: Record<string, BadgeConfig> = {
  // ── Canonical statuses (migrations 148 + 166) ─────────────────────────────
  SEARCHING: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING',
    bgClass: 'bg-blue-yonder',
  },
  SEARCHING_REPLACEMENT: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING_REPLACEMENT',
    bgClass: 'bg-wait',
  },
  RAPID_RESPONSE: {
    labelKey: 'admin.vacancyDetail.statusBadge.RAPID_RESPONSE',
    bgClass: 'bg-wait',
  },
  PENDING_ACTIVATION: {
    labelKey: 'admin.vacancyDetail.statusBadge.PENDING_ACTIVATION',
    bgClass: 'bg-cyan-focus',
  },
  ACTIVE: {
    labelKey: 'admin.vacancyDetail.statusBadge.ACTIVE',
    bgClass: 'bg-blue-yonder',
  },
  ON_HOLD: {
    labelKey: 'admin.vacancyDetail.statusBadge.ON_HOLD',
    bgClass: 'bg-wait',
  },
  SUSPENDED: {
    labelKey: 'admin.vacancyDetail.statusBadge.SUSPENDED',
    bgClass: 'bg-gray-800',
  },
  CLOSED: {
    labelKey: 'admin.vacancyDetail.statusBadge.CLOSED',
    bgClass: 'bg-gray-800',
  },
  // ── Patient-level status surfaced on the same badge ───────────────────────
  ADMISSION: {
    labelKey: 'admin.vacancyDetail.statusBadge.ADMISSION',
    bgClass: 'bg-cyan-focus',
  },
  // ── Legacy aliases (kept for backward compatibility, pre-migration 148) ───
  BUSQUEDA: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING',
    bgClass: 'bg-blue-yonder',
  },
  ACTIVO: {
    labelKey: 'admin.vacancyDetail.statusBadge.ACTIVE',
    bgClass: 'bg-blue-yonder',
  },
  REEMPLAZOS: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING_REPLACEMENT',
    bgClass: 'bg-wait',
  },
  REEMPLAZO: {
    labelKey: 'admin.vacancyDetail.statusBadge.SEARCHING_REPLACEMENT',
    bgClass: 'bg-wait',
  },
  CERRADO: {
    labelKey: 'admin.vacancyDetail.statusBadge.CLOSED',
    bgClass: 'bg-gray-800',
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
  const label = config ? t(config.labelKey) : capitalize(status ?? '');

  return (
    <span
      className={`inline-flex items-center justify-center text-white font-poppins font-semibold text-xs px-6 py-1 rounded ${bgClass} ${className}`}
    >
      {label}
    </span>
  );
}
