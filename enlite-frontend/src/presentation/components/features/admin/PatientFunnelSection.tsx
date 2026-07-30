import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, ClipboardCheck, CalendarCheck, Briefcase } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { Select } from '@presentation/components/atoms/Select';
import { StatCard } from '@presentation/components/features/admin/PatientStatsCards';
import { usePatientFunnel } from '@hooks/admin/usePatientFunnel';
import { getCountryOptions, getFunnelPeriodOptions } from '@presentation/pages/admin/patientsData';

/** Whole-number conversion rate between two consecutive funnel stages. */
function conversionRate(prev: number, next: number): number {
  return prev > 0 ? Math.round((next / prev) * 100) : 0;
}

/**
 * Fase 4 — funnel/traceability metrics strip for the patients page.
 * Solicitantes → Admisión → Agendadas → Vacantes, with stage-to-stage
 * conversion rates. Scoped by country + a relative period (30 days default).
 */
export function PatientFunnelSection(): JSX.Element {
  const { t } = useTranslation();
  const [country, setCountry] = useState('');
  const [periodDays, setPeriodDays] = useState('30');

  const { funnel, isLoading, error } = usePatientFunnel(country, parseInt(periodDays, 10));

  const countryOptions = getCountryOptions(t);
  const periodOptions = getFunnelPeriodOptions(t);

  const solicitantes = funnel?.solicitantes ?? 0;
  const admision = funnel?.admision ?? 0;
  const agendadas = funnel?.agendadas ?? 0;
  const vacantes = funnel?.vacantes ?? 0;

  return (
    <section className="mb-12" data-testid="patient-funnel-section">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <Typography variant="h1" weight="semibold" className="text-[#737373] font-poppins text-xl">
          {t('admin.patients.funnel.title')}
        </Typography>
        <div className="flex items-center gap-3">
          <div className="w-[160px]" data-testid="funnel-country-filter">
            <Select
              inputSize="compact"
              options={countryOptions}
              value={country}
              onValueChange={setCountry}
              placeholder={t('admin.patients.countryOptions.all')}
            />
          </div>
          <div className="w-[180px]" data-testid="funnel-period-filter">
            <Select
              inputSize="compact"
              options={periodOptions}
              value={periodDays}
              onValueChange={setPeriodDays}
            />
          </div>
        </div>
      </div>

      {error ? (
        <Typography variant="body" className="text-red-600">
          {t('admin.patients.funnel.error', { defaultValue: error })}
        </Typography>
      ) : (
        <>
          <div
            className={`flex flex-col sm:flex-row items-stretch sm:items-center gap-4 ${isLoading ? 'opacity-60' : ''}`}
          >
            <StatCard
              label={t('admin.patients.funnel.solicitantes')}
              value={solicitantes}
              icon={<Users className="w-6 h-6 text-white" strokeWidth={1.5} />}
              testId="funnel-solicitantes"
            />
            <StatCard
              label={t('admin.patients.funnel.admision')}
              value={admision}
              icon={<ClipboardCheck className="w-6 h-6 text-white" strokeWidth={1.5} />}
              testId="funnel-admision"
            />
            <StatCard
              label={t('admin.patients.funnel.agendadas')}
              value={agendadas}
              icon={<CalendarCheck className="w-6 h-6 text-white" strokeWidth={1.5} />}
              testId="funnel-agendadas"
            />
            <StatCard
              label={t('admin.patients.funnel.vacantes')}
              value={vacantes}
              icon={<Briefcase className="w-6 h-6 text-white" strokeWidth={1.5} />}
              testId="funnel-vacantes"
            />
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-1 mt-3">
            <Typography variant="body" className="text-[#737373] text-sm" data-testid="funnel-conv-solicitantes-admision">
              {t('admin.patients.funnel.conversion', {
                from: t('admin.patients.funnel.solicitantes'),
                to: t('admin.patients.funnel.admision'),
                rate: conversionRate(solicitantes, admision),
              })}
            </Typography>
            <Typography variant="body" className="text-[#737373] text-sm" data-testid="funnel-conv-admision-agendadas">
              {t('admin.patients.funnel.conversion', {
                from: t('admin.patients.funnel.admision'),
                to: t('admin.patients.funnel.agendadas'),
                rate: conversionRate(admision, agendadas),
              })}
            </Typography>
            <Typography variant="body" className="text-[#737373] text-sm" data-testid="funnel-conv-agendadas-vacantes">
              {t('admin.patients.funnel.conversion', {
                from: t('admin.patients.funnel.agendadas'),
                to: t('admin.patients.funnel.vacantes'),
                rate: conversionRate(agendadas, vacantes),
              })}
            </Typography>
          </div>
        </>
      )}
    </section>
  );
}
