import { useTranslation } from 'react-i18next';
import { Eye } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';

interface VacancyPatientCardProps {
  firstName: string | null;
  lastName: string | null;
  /** Kept for backward compat — no longer displayed in the Figma layout */
  diagnosis?: string | null;
  /** Kept for backward compat — no longer displayed in the Figma layout */
  zone?: string | null;
  /** Kept for backward compat — no longer displayed in the Figma layout */
  insuranceVerified?: boolean | null;
}

export function VacancyPatientCard({
  firstName,
  lastName,
}: VacancyPatientCardProps) {
  const { t } = useTranslation();
  const patientName = [firstName, lastName].filter(Boolean).join(' ') || '—';

  return (
    <div className="border-[2.5px] border-gray-400 rounded-card bg-white p-8 flex flex-col gap-3.5">
      <Typography variant="card-title" color="primary" weight="semibold">
        {t('admin.vacancyDetail.patientCard.title')}
      </Typography>
      <Typography variant="label" color="secondary" weight="semibold">
        {t('admin.vacancyDetail.patientCard.nameLabel')}
      </Typography>
      <div className="flex items-center gap-2">
        <Eye
          className="text-gray-800 shrink-0"
          style={{ width: 23, height: 20 }}
          strokeWidth={1.5}
        />
        <Typography variant="value" color="primary" weight="medium">
          {patientName}
        </Typography>
      </div>
    </div>
  );
}
