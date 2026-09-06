import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronRight, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { usePatientDetail } from '@hooks/admin/usePatientDetail';
import { usePatientVacancies } from '@hooks/admin/usePatientVacancies';
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
import { PatientVacanciesCard } from '@presentation/components/features/admin/PatientDetail/PatientVacanciesCard';
import { ActivatePatientButton } from '@presentation/components/features/admin/PatientDetail/ActivatePatientButton';
import { PatientChatIdsCard } from '@presentation/components/features/admin/PatientDetail/PatientChatIdsCard';
import { PatientStatusControl } from '@presentation/components/features/admin/PatientDetail/PatientStatusControl';
import { PatientStatusHistoryCard } from '@presentation/components/features/admin/PatientDetail/PatientStatusHistoryCard';
import { CompletenessChecklist } from '@presentation/components/features/admin/PatientDetail/CompletenessChecklist';
import type { DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';
import { ContainerGate } from '@presentation/components/features/access';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { containersVisibleFor } from '@presentation/hooks/useCellAccess';
import { containersOfTab, screenById } from '@presentation/config/screenRegistry';
import { PATIENT_TABS } from '@presentation/components/features/admin/PatientDetail/patientTabs';
import type { PatientCompletenessCode } from '@domain/entities/PatientDetail';
import { ACTIVATABLE_STATUSES } from '@domain/entities/PatientCompleteness';

/** Spec 014 US-D1: cada código do checklist sabe em qual aba o card vive. */
const COMPLETENESS_TAB: Record<PatientCompletenessCode, PatientTab> = {
  ADDRESS: 'contractedService',
  RESPONSIBLE: 'supportNetwork',
  COVERAGE: 'contractedService',
  CONTRACTED_SERVICE: 'contractedService',
  CONSENT: 'clinicalData',
};

const COUNTRY_FLAG: Record<string, string> = {
  AR: '🇦🇷',
  BR: '🇧🇷',
  UY: '🇺🇾',
};

export default function PatientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { patient, isLoading, error, refetch } = usePatientDetail(id);
  const { vacancies, isLoading: vacanciesLoading, error: vacanciesError, refetch: refetchVacancies } = usePatientVacancies(id);
  const [activeTab, setActiveTab] = useState<PatientTab>('clinicalData');
  // D286: uma aba só existe se ALGUM container dela for legível (registro de telas + contrato de
  // authz). A ativa é a primeira visível quando a atual sumiu; sem enforcement, todas existem.
  const permissions = useAdminAuthStore((s) => s.authz?.permissions);
  const enforcement = useAdminAuthStore((s) => s.authz?.enforcement);
  const screen = screenById('patients.detail');
  const visibleTabs = PATIENT_TABS.filter((tab) =>
    containersVisibleFor(permissions, enforcement, containersOfTab(screen, tab).map((ct) => ct.resource)),
  );
  const shownTab: PatientTab | null = visibleTabs.includes(activeTab) ? activeTab : (visibleTabs[0] ?? null);
  // Spec 014 US-D1: pedido de foco do checklist — muda de aba E pede ao card certo (via
  // `useAutoOpenDrawer`) que abra seu próprio drawer, sem o pai conhecer o estado interno dele.
  const [focusRequest, setFocusRequest] = useState<DrawerFocusRequest | null>(null);
  const focusChecklistItem = (code: PatientCompletenessCode) => {
    setActiveTab(COMPLETENESS_TAB[code]);
    setFocusRequest({ code, token: Date.now() });
  };
  /**
   * F3 — o pedido de foco tem de MORRER na troca de aba. `focusRequest` era escrito só em
   * `focusChecklistItem` e nada o devolvia a `null`; como os cards são montados POR ABA, o
   * de-dupe do `useAutoOpenDrawer` (um `useRef`) morria junto com o componente e o pedido antigo
   * era obedecido DE NOVO na remontagem: ela clicava em "Cobertura" no checklist, fechava o
   * drawer, ia para "Rede de apoio", voltava — e o drawer abria sozinho por cima do trabalho
   * dela. Trocar de aba À MÃO é um ato dela, não do checklist: consome o pedido.
   * (`focusChecklistItem` NÃO passa por aqui — ele troca a aba e escreve o pedido novo.)
   */
  const changeTab = (tab: PatientTab) => {
    setFocusRequest(null);
    setActiveTab(tab);
  };

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
        <div className="flex items-center gap-3 shrink-0 ml-4">
          {/* Spec 014 US-D5: a ficha ganha o caminho de volta ao Kanban (antes só existia da
              lista para a ficha, nunca o inverso). */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/admin/patients/kanban')}
            className="flex items-center gap-1"
            data-testid="view-in-kanban-btn"
          >
            <LayoutGrid className="w-4 h-4" />
            {t('admin.patients.detail.viewInKanban')}
          </Button>
          {/* Spec 012 US-B7: estado clínico v2 (só depois da admissão); antes, o botão Activar. */}
          <PatientStatusControl patient={patient} onSaved={refetch} />
          <ActivatePatientButton
            patientId={patient.id}
            status={patient.status}
            onActivated={() => { refetch(); refetchVacancies(); }}
          />
          <span className="text-2xl" role="img" aria-label={countryLabel}>{countryFlag}</span>
          <Text as="span" size="sm" weight="medium" color="secondary" className="hidden sm:block">
            {countryLabel}
          </Text>
        </div>
      </div>

      {/* Checklist de completude (spec 014 US-D1) — bloco fixo no topo, SÓ em status
          ACTIVATABLE (QA-caça rodada 1, item 3): fora dali (ex.: ACTIVE, já aprovado) é ruído
          permanente sem ação possível — a mesma constante que ActivatePatientButton usa. */}
      {patient.status != null &&
        (ACTIVATABLE_STATUSES as readonly string[]).includes(patient.status) && (
          <CompletenessChecklist completeness={patient.completeness} onFocusItem={focusChecklistItem} />
        )}

      {/* Row 1: Identity + General Info (2 columns) */}
      <ContainerGate resource="patient_identity">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <PatientIdentityCard patient={patient} onSaved={refetch} />
          <PatientGeneralInfoCard patient={patient} onSaved={refetch} />
        </div>
      </ContainerGate>

      {/* Tab Navigation */}
      {shownTab !== null && (
        <div className="mb-6">
          <PatientProfileTabs activeTab={shownTab} onTabChange={changeTab} visibleTabs={visibleTabs} />
        </div>
      )}

      {/* Tab Content — cada card atrás do gate do SEU container (D286). A resposta já veio
          projetada pelo back; o gate só evita mostrar um card vazio onde a pessoa não pode agir. */}
      <div className="mb-6 flex flex-col gap-6">
        {shownTab === 'clinicalData' && (
          <>
            <ContainerGate resource="patient_clinical">
              <DiagnosticoCard patient={patient} onSaved={refetch} focusRequest={focusRequest} />
            </ContainerGate>
            <ProjetoTerapeuticoCard />
            <ContainerGate resource="patient_care_team">
              <EquipeTratanteCard professionals={patient.professionals} />
            </ContainerGate>
            <SupervisaoCard />
            <RelatoriosAtendimentosCard />
          </>
        )}
        {shownTab === 'supportNetwork' && (
          <>
            <ContainerGate resource="patient_family">
              <FamiliaresCard responsibles={patient.responsibles} patientId={patient.id} onSaved={refetch} focusRequest={focusRequest} />
            </ContainerGate>
            {/* Chat IDs dos grupos do Periskope — a chave de join da auditoria
                de informes (Candela). Fica na rede de apoio porque é onde a
                família e a equipe de prestadores já são tratadas. */}
            <ContainerGate resource="patient_chat">
              <PatientChatIdsCard patient={patient} onSaved={refetch} />
            </ContainerGate>
          </>
        )}
        {shownTab === 'contractedService' && (
          <>
            <ContainerGate resource="patient_coverage">
              <CoberturaMedicaCard patient={patient} onSaved={refetch} focusRequest={focusRequest} />
            </ContainerGate>
            <ContainerGate resource="patient_address">
              <LocalizacoesCard addresses={patient.addresses} patientId={patient.id} onSaved={refetch} focusRequest={focusRequest} />
            </ContainerGate>
            <ContainerGate resource="patient_services">
              <ServicosContratadosCard patient={patient} onSaved={refetch} focusRequest={focusRequest} />
            </ContainerGate>
          </>
        )}
        {shownTab === 'vacancies' && (
          <ContainerGate resource="vacancy">
            <PatientVacanciesCard
              patientId={patient.id}
              vacancies={vacancies}
              isLoading={vacanciesLoading}
              error={vacanciesError}
            />
          </ContainerGate>
        )}
        {shownTab === 'matching' && (
          <>
            <ContainerGate resource="patient_services">
              <ServicosContratadosCard patient={patient} />
            </ContainerGate>
            <EnquadreTerapeuticoCard />
          </>
        )}
        {shownTab === 'history' && (
          <PatientStatusHistoryCard patientId={patient.id} />
        )}
      </div>
    </div>
  );
}
