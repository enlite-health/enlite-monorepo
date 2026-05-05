/**
 * AdminRecruitmentPage
 * Dashboard de Reclutamiento y Encuadre - Migrated from Dashboard Reclutamiento
 * 
 * NOTA: Esta é a versão inicial com estrutura visual.
 * A integração com worker-functions será feita posteriormente.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Typography } from '@presentation/components/atoms/Typography';
import { MetricCard } from '@presentation/components/atoms/MetricCard';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { DateRangeFilter } from '@presentation/components/molecules/DateRangeFilter';
import { CaseSearchBar } from '@presentation/components/molecules/CaseSearchBar';
import { ActiveCasesTable } from '@presentation/components/organisms/ActiveCasesTable';
import { PublicationsBarChart } from '@presentation/components/organisms/PublicationsBarChart';
import { useDashboardData } from '@hooks/recruitment/useDashboardData';
import { useGlobalMetrics } from '@hooks/recruitment/useGlobalMetrics';
import { useActiveCases } from '@hooks/recruitment/useActiveCases';
import type { DateFilterType } from '@domain/entities/RecruitmentData';
import { BarChart3, MapPin, FileSpreadsheet } from 'lucide-react';
import { DashboardSkeleton } from '@presentation/components/ui/skeletons';

type TabType = 'global' | 'caso' | 'zona';

export function AdminRecruitmentPage(): JSX.Element {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabType>('global');
  const [dateFilter, setDateFilter] = useState<DateFilterType>('1m');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [selectedCase, setSelectedCase] = useState('');

  // Fetch dashboard data
  const { clickUpData, talentumData, pubData, baseData, progresoData, isLoading, error } =
    useDashboardData();

  // Calculate metrics
  const globalMetrics = useGlobalMetrics({
    clickUpData,
    talentumData,
    pubData,
    baseData,
    progresoData,
    dateFilter,
    customStartDate,
    customEndDate,
  });

  const activeCases = useActiveCases(clickUpData);

  const handleCaseClick = (caseId: string): void => {
    setSelectedCase(caseId);
    setActiveTab('caso');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <PageContainer>
      {/* Page Header */}
      <div className="flex items-center justify-between mb-10">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-8 h-8 text-primary" />
          <Typography variant="h1" weight="semibold" color="primary" className="font-poppins">
            {t('admin.recruitment.title')}
          </Typography>
        </div>
        <div className="flex items-center gap-2">
          <img
            className="w-7 h-5"
            alt="Argentina"
            src="https://c.animaapp.com/UVSSEdVv/img/group-237688.svg"
          />
          <Typography variant="body" weight="medium" className="text-[#737373]">
            {t('common.country')}
          </Typography>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="bg-white rounded-t-2xl border-b border-slate-200 mb-6">
        <div className="flex items-center justify-between px-8 py-4">
          <div className="flex space-x-8">
            <button
              onClick={() => setActiveTab('global')}
              className={`pb-4 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'global'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t('admin.recruitment.tabs.global')}
            </button>
            <button
              onClick={() => setActiveTab('caso')}
              className={`pb-4 text-sm font-medium border-b-2 transition-colors ${
                activeTab === 'caso'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              {t('admin.recruitment.tabs.case')}
            </button>
            <button
              onClick={() => setActiveTab('zona')}
              className={`pb-4 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${
                activeTab === 'zona'
                  ? 'border-cyan-500 text-cyan-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <MapPin className="w-3.5 h-3.5" />
              {t('admin.recruitment.tabs.zone')}
            </button>
          </div>

          <DateRangeFilter
            value={dateFilter}
            onChange={setDateFilter}
            customStartDate={customStartDate}
            customEndDate={customEndDate}
            onCustomStartChange={setCustomStartDate}
            onCustomEndChange={setCustomEndDate}
          />
        </div>
      </div>

      {/* Tab Content */}
      <div className="bg-white rounded-b-2xl shadow-sm p-8">
        {isLoading && <DashboardSkeleton />}
        {error && (
          <div className="py-8 text-center">
            <Typography variant="h3" className="text-red-600 mb-2">{t('admin.recruitment.errorLoading')}</Typography>
            <Typography variant="body" className="text-slate-600">{error}</Typography>
          </div>
        )}
        {/* Global Tab */}
        {!isLoading && !error && activeTab === 'global' && (
          <div className="space-y-8">
            <Typography variant="h2" weight="semibold" className="mb-6">
              {t('admin.recruitment.metrics.globalMetrics')}
            </Typography>

            {/* Metrics Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <MetricCard
                title={t('admin.recruitment.metrics.activeCases')}
                value={globalMetrics.activeCasesCount}
                subtitle={`${t('admin.recruitment.metrics.search')}: ${globalMetrics.busquedaCount} | ${t('admin.recruitment.metrics.replacements')}: ${globalMetrics.reemplazoCount}`}
              />
              <MetricCard
                title={t('admin.recruitment.metrics.candidates')}
                value={globalMetrics.candidatosEnProgresoCount}
                subtitle={t('admin.recruitment.metrics.candidatesSubtitle')}
              />
              <MetricCard
                title={t('admin.recruitment.metrics.applicants')}
                value={globalMetrics.postulantesInTalentumCount}
                subtitle={t('admin.recruitment.metrics.applicantsSubtitle')}
              />
              <MetricCard
                title={t('admin.recruitment.metrics.frameworks')}
                value={globalMetrics.cantidadEncuadres}
                subtitle={t('admin.recruitment.metrics.frameworksSubtitle')}
              />
            </div>

            {/* Publications Chart */}
            <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
              <div className="flex justify-between items-center mb-6">
                <Typography variant="h3" weight="semibold">
                  {t('admin.recruitment.metrics.publicationsByChannel')}
                </Typography>
                <span className="text-sm font-medium text-primary bg-primary/10 px-3 py-1 rounded-full">
                  {t('admin.recruitment.metrics.total')}: {globalMetrics.totalPubs}
                </span>
              </div>
              <PublicationsBarChart data={globalMetrics.pubChartData} />
            </div>

            {/* Active Cases Table */}
            {activeCases.length > 0 && (
              <div className="bg-white dark:bg-slate-800 p-6 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="w-5 h-5 text-primary" />
                    <Typography variant="h3" weight="semibold">
                      {t('admin.recruitment.metrics.activeCasesList')}
                    </Typography>
                  </div>
                </div>
                <ActiveCasesTable cases={activeCases} onCaseClick={handleCaseClick} />
              </div>
            )}
          </div>
        )}

        {/* Caso Tab */}
        {!isLoading && !error && activeTab === 'caso' && (
          <div className="space-y-8">
            <Typography variant="h2" weight="semibold" className="mb-6">
              {t('admin.recruitment.caseAnalysis.title')}
            </Typography>

            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
              <CaseSearchBar value={selectedCase} onChange={setSelectedCase} />
            </div>

            {selectedCase ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <MetricCard title={t('admin.recruitment.metrics.candidates')} value={0} subtitle={t('admin.recruitment.caseAnalysis.candidatesInProgress')} />
                <MetricCard title={t('admin.recruitment.metrics.applicants')} value={0} subtitle={t('admin.recruitment.caseAnalysis.applicantsInTalentum')} />
                <MetricCard title={t('admin.recruitment.caseAnalysis.invited')} value={0} subtitle={t('admin.recruitment.caseAnalysis.invitedSubtitle')} />
                <MetricCard title={t('admin.recruitment.metrics.frameworks')} value={0} subtitle={t('admin.recruitment.metrics.frameworksSubtitle')} />
              </div>
            ) : (
              <div className="text-center py-12 text-slate-500">
                {t('admin.recruitment.caseAnalysis.noCase')}
              </div>
            )}
          </div>
        )}

        {/* Zona Tab */}
        {!isLoading && !error && activeTab === 'zona' && (
          <div className="space-y-8">
            <div className="flex items-center gap-3 mb-6">
              <MapPin className="w-6 h-6 text-cyan-600" />
              <Typography variant="h2" weight="semibold">
                {t('admin.recruitment.zoneAnalysis.title')}
              </Typography>
            </div>

            <div className="text-center py-12 text-slate-500">
              <MapPin className="w-16 h-16 mx-auto mb-4 text-slate-300" />
              <Typography variant="body" className="text-slate-600">
                {t('admin.recruitment.zoneAnalysis.comingSoon')}
              </Typography>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
