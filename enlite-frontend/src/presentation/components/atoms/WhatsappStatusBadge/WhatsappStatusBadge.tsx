import { useTranslation } from 'react-i18next';
import type { WhatsappStatus } from '@domain/entities/Funnel';

interface WhatsappStatusBadgeProps {
  status: WhatsappStatus | null;
}

interface StatusConfig {
  labelKey: string;
  bgClass: string;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  NOT_SENT: {
    labelKey: 'admin.vacancyDetail.whatsappStatus.notSent',
    bgClass: 'bg-cancelled',
  },
  SENT: {
    labelKey: 'admin.vacancyDetail.whatsappStatus.sent',
    bgClass: 'bg-blue-yonder',
  },
  DELIVERED: {
    labelKey: 'admin.vacancyDetail.whatsappStatus.delivered',
    bgClass: 'bg-cyan-focus',
  },
  READ: {
    labelKey: 'admin.vacancyDetail.whatsappStatus.read',
    bgClass: 'bg-new-car',
  },
  REPLIED: {
    labelKey: 'admin.vacancyDetail.whatsappStatus.replied',
    bgClass: 'bg-turquoise',
  },
  FAILED: {
    labelKey: 'admin.vacancyDetail.whatsappStatus.failed',
    bgClass: 'bg-cancelled',
  },
};

const NULL_CONFIG: StatusConfig = {
  labelKey: 'admin.vacancyDetail.whatsappStatus.notSent',
  bgClass: 'bg-cancelled',
};

export function WhatsappStatusBadge({
  status,
}: WhatsappStatusBadgeProps): JSX.Element {
  const { t } = useTranslation();
  const config = status ? (STATUS_CONFIG[status] ?? NULL_CONFIG) : NULL_CONFIG;

  return (
    <span
      className={`inline-flex items-center justify-center text-white font-poppins font-semibold text-[10px] leading-[1.5] px-5 py-1 rounded min-w-[60px] ${config.bgClass}`}
    >
      {t(config.labelKey)}
    </span>
  );
}
