/**
 * InsuranceProviderDetailPage — a obra social por cartões (spec 058 §4.2): Dados gerais · Empregados · Contratos · Pacientes.
 * Sem popup (D-48); cada cartão tem a sua edição e a sua célula. Fica FORA da ficha do paciente (não muda aba nem ordem de lá).
 *
 * Rota de tela pela célula de leitura (`catalog_insurance_providers:read`) — defesa em profundidade; quem manda é o 403 do back.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Building2 } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { useContainerAccess } from '@presentation/hooks/useCellAccess';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import type { InsuranceProviderDetail } from '@domain/entities/InsuranceProviderDetail';
import { insuranceErrorText } from '@presentation/utils/insuranceErrors';
import { ContractsCard } from './ContractsCard';
import { EmployeesCard } from './EmployeesCard';
import { GeneralCard } from './GeneralCard';
import { PatientsCard } from './PatientsCard';
import { useCardLoad } from './useCardLoad';
import { CardMessage } from './ProviderCard';

const NS = 'admin.insuranceProviders';

export default function InsuranceProviderDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { code = '' } = useParams<{ code: string }>();

  const { visible } = useContainerAccess('catalog_insurance_providers');
  useEffect(() => {
    if (!visible) navigate('/admin', { replace: true });
  }, [visible, navigate]);

  const { data, error, loading } = useCardLoad(() => AdminInsuranceApiService.getProvider(code), visible && code !== '', [code]);
  // Dados gerais salvos: o cartão devolve o detalhe novo e ele passa a valer sem recarregar a página.
  const [saved, setSaved] = useState<InsuranceProviderDetail | null>(null);
  const [editRequest, setEditRequest] = useState(0);
  const provider = saved ?? data;
  useEffect(() => { setSaved(null); }, [code]);

  function goToGeneral(): void {
    setEditRequest((n) => n + 1);
    document.getElementById('provider-general-card')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }

  return (
    <PageContainer>
      <div className="mb-4">
        <Link to="/admin/obras-sociales" className="text-sm text-primary underline" data-testid="provider-back">{t(`${NS}.detail.back`)}</Link>
      </div>
      <div className="flex items-center gap-2 mb-6">
        <Building2 className="w-6 h-6 text-primary" />
        <Heading level={1} weight="semibold" color="primary">{provider?.name ?? t(`${NS}.title`)}</Heading>
      </div>

      {loading ? (
        <DetailSkeleton />
      ) : error || !provider ? (
        <CardMessage testId="provider-load-error" tone="error">
          {error ? insuranceErrorText(t, error) : t(`${NS}.detail.notFound`)}
        </CardMessage>
      ) : (
        <div className="flex flex-col gap-6" data-testid="provider-detail">
          <GeneralCard provider={provider} onSaved={setSaved} editRequest={editRequest} />
          <EmployeesCard code={provider.code} />
          <ContractsCard code={provider.code} onGoToGeneral={goToGeneral} />
          <PatientsCard code={provider.code} />
        </div>
      )}
    </PageContainer>
  );
}
