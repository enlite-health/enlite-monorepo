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
  BUSQUEDA: {
    labelKey: 'admin.vacancyDetail.statusBadge.BUSQUEDA',
    bgClass: 'bg-blue-yonder',
  },
  ACTIVO: {
    labelKey: 'admin.vacancyDetail.statusBadge.ACTIVO',
    bgClass: 'bg-blue-yonder',
  },
  ACTIVE: {
    labelKey: 'admin.vacancyDetail.statusBadge.ACTIVO',
    bgClass: 'bg-blue-yonder',
  },
  REEMPLAZOS: {
    labelKey: 'admin.vacancyDetail.statusBadge.REEMPLAZOS',
    bgClass: 'bg-wait',
  },
  REEMPLAZO: {
    labelKey: 'admin.vacancyDetail.statusBadge.REEMPLAZOS',
    bgClass: 'bg-wait',
  },
  CERRADO: {
    labelKey: 'admin.vacancyDetail.statusBadge.CERRADO',
    bgClass: 'bg-gray-800',
  },
  CLOSED: {
    labelKey: 'admin.vacancyDetail.statusBadge.CERRADO',
    bgClass: 'bg-gray-800',
  },
  ADMISSION: {
    labelKey: 'admin.vacancyDetail.statusBadge.ADMISSION',
    bgClass: 'bg-cyan-focus',
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
