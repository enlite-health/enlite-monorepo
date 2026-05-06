import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { usePatientDetail } from '@hooks/admin/usePatientDetail';
import { PatientIdentityCard } from '@presentation/components/features/admin/PatientDetail/PatientIdentityCard';
import { PatientGeneralInfoCard } from '@presentation/components/features/admin/PatientDetail/PatientGeneralInfoCard';
import { PatientProfileTabs, PatientTab } from '@presentation/components/features/admin/PatientDetail/PatientProfileTabs';
import { DiagnosticoCard } from '@presentation/components/features/admin/PatientDetail/DiagnosticoCard';
import { ProjetoTerapeuticoCard } from '@presentation/components/features/admin/PatientDetail/ProjetoTerapeuticoCard';
import { EquipeTratanteCard } from '@presentation/components/features/admin/PatientDetail/EquipeTratanteCard';
import { SupervisaoCard } from '@presentation/components/features/admin/PatientDetail/SupervisaoCard';
import { RelatoriosAtendimentosCard } from '@presentation/components/features/admin/PatientDetail/RelatoriosAtendimentosCard';
import { FamiliaresCard } from '@presentation/components/features/admin/PatientDetail/FamiliaresCard';
import { CoberturaMedicaCard } from '@presentation/components/features/admin/PatientDetail/CoberturaMedicaCard';
import { LocalizacoesCard } from '@presentation/components/features/admin/PatientDetail/LocalizacoesCard';
import { ServicosContratadosCard } from '@presentation/components/features/admin/PatientDetail/ServicosContratadosCard';
import { EnquadreTerapeuticoCard } from '@presentation/components/features/admin/PatientDetail/EnquadreTerapeuticoCard';

const COUNTRY_FLAG: Record<string, string> = {
  AR: '🇦🇷',
  BR: '🇧🇷',
  UY: '🇺🇾',
};

export default function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { patient, isLoading, error } = usePatientDetail(id);
  const [activeTab, setActiveTab] = useState<PatientTab>('clinicalData');

  if (isLoading) return <DetailSkeleton />;

  if (error || !patient) {
    const isNotFound = error?.toLowerCase().includes('not found') || error?.includes('404');
    return (
      <div className="w-full min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <Heading level={3} color="inherit" className="text-red-600">
          {isNotFound ? t('admin.patients.detail.notFound') : (error ?? t('admin.patients.detail.errorLoading'))}
        </Heading>
        <Button variant="outline" size="sm" onClick={() => navigate('/admin/patients')}>
          {t('admin.patients.detail.backToList')}
        </Button>
      </div>
    );
  }

  const countryFlag = COUNTRY_FLAG[patient.country] ?? COUNTRY_FLAG.AR;
  const countryLabel = t(`admin.patients.detail.country.${patient.country}`, patient.country);

  return (
    <div className="w-full min-h-screen bg-background px-4 sm:px-8 lg:px-12 xl:px-[120px] py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => navigate('/admin/patients')}
            className="flex items-center gap-1 text-gray-800 hover:text-primary transition-colors shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
            <Text as="span" size="sm" weight="medium" color="inherit">
              {t('admin.patients.detail.backToList')}
            </Text>
          </button>
          <ChevronRight className="w-4 h-4 text-gray-600 shrink-0" />
          <Heading level={1} weight="semibold" color="primary" className="truncate">
            {t('admin.patients.detail.pageTitle')}
          </Heading>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-4">
          <span className="text-2xl" role="img" aria-label={countryLabel}>{countryFlag}</span>
          <Text as="span" size="sm" weight="medium" color="secondary" className="hidden sm:block">
            {countryLabel}
          </Text>
        </div>
      </div>

      {/* Row 1: Identity + General Info (2 columns) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <PatientIdentityCard patient={patient} />
        <PatientGeneralInfoCard patient={patient} />
      </div>

      {/* Tab Navigation */}
      <div className="mb-6">
        <PatientProfileTabs activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Tab Content */}
      <div className="mb-6 flex flex-col gap-6">
        {activeTab === 'clinicalData' && (
          <>
            <DiagnosticoCard patient={patient} />
            <ProjetoTerapeuticoCard />
            <EquipeTratanteCard professionals={patient.professionals ?? []} />
            <SupervisaoCard />
            <RelatoriosAtendimentosCard />
          </>
        )}
        {activeTab === 'supportNetwork' && (
          <FamiliaresCard responsibles={patient.responsibles ?? []} />
        )}
        {activeTab === 'contractedService' && (
          <>
            <CoberturaMedicaCard patient={patient} />
            <LocalizacoesCard addresses={patient.addresses ?? []} />
            <ServicosContratadosCard patient={patient} />
          </>
        )}
        {activeTab === 'matching' && (
          <>
            <ServicosContratadosCard patient={patient} />
            <EnquadreTerapeuticoCard />
          </>
        )}
        {activeTab !== 'clinicalData'
          && activeTab !== 'supportNetwork'
          && activeTab !== 'contractedService'
          && activeTab !== 'matching' && (
          <PlaceholderTab label={t(`admin.patients.detail.tabs.${activeTab}`)} />
        )}
      </div>
    </div>
  );
}

function PlaceholderTab({ label }: { label: string }) {
  const { t } = useTranslation();
  return (
    <div className="bg-white rounded-card border-2 border-gray-600 p-6 sm:px-8 sm:py-10 flex items-center justify-center min-h-[200px]">
      <Text size="sm" color="muted">
        {label} — {t('admin.patients.detail.comingSoon')}
      </Text>
    </div>
  );
}
