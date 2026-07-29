import { useTranslation } from 'react-i18next';
import { Users, CheckCircle, AlertTriangle } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { PatientStats } from '@infrastructure/http/AdminPatientsApiService';

export interface PatientStatsCardsProps {
  stats: PatientStats | null;
}

function SkeletonCard(): JSX.Element {
  return (
    <div className="flex items-center justify-center gap-4 px-4 py-9 flex-1 min-w-0 bg-primary rounded-[20px] border-[1.5px] border-solid border-primary animate-pulse">
      <div className="bg-[rgba(255,255,255,0.15)] flex items-center justify-center p-2.5 rounded-full w-16 h-16">
        <div className="w-6 h-6 rounded-full bg-[rgba(255,255,255,0.3)]" />
      </div>
      <div className="flex flex-col items-start gap-2">
        <div className="h-4 w-28 rounded bg-[rgba(255,255,255,0.3)]" />
        <div className="h-8 w-16 rounded bg-[rgba(255,255,255,0.3)]" />
      </div>
    </div>
  );
}

export interface StatCardProps {
  label: string;
  value: number;
  icon: JSX.Element;
  testId: string;
}

/** Primary KPI card. Reused by the Fase 4 funnel strip (PatientFunnelSection). */
export function StatCard({ label, value, icon, testId }: StatCardProps): JSX.Element {
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-center gap-4 px-4 py-9 flex-1 min-w-0 bg-primary rounded-[20px] border-[1.5px] border-solid border-primary"
    >
      <div className="bg-[rgba(255,255,255,0.15)] border border-[rgba(255,255,255,0.15)] border-solid flex items-center justify-center p-2.5 rounded-full w-16 h-16">
        {icon}
      </div>
      <div className="flex flex-col items-start">
        <Typography variant="body" weight="medium" className="text-white font-lexend text-base">
          {label}
        </Typography>
        <Typography
          variant="h1"
          weight="semibold"
          className="text-white font-lexend text-[32px] leading-[1.25]"
        >
          {value}
        </Typography>
      </div>
    </div>
  );
}

export function PatientStatsCards({ stats }: PatientStatsCardsProps): JSX.Element {
  const { t } = useTranslation();

  if (stats === null) {
    return (
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 mb-12">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-4 mb-12">
      <StatCard
        label={t('admin.patients.stats.total')}
        value={stats.total}
        icon={<Users className="w-6 h-6 text-white" strokeWidth={1.5} />}
        testId="patient-stats-total"
      />
      <StatCard
        label={t('admin.patients.stats.complete')}
        value={stats.complete}
        icon={<CheckCircle className="w-6 h-6 text-white" strokeWidth={1.5} />}
        testId="patient-stats-complete"
      />
      <StatCard
        label={t('admin.patients.stats.needsAttention')}
        value={stats.needsAttention}
        icon={<AlertTriangle className="w-6 h-6 text-white" strokeWidth={1.5} />}
        testId="patient-stats-needs-attention"
      />
    </div>
  );
}
