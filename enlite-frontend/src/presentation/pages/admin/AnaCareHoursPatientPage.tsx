/**
 * Página-rota do detalhe de paciente da conferência de horas (`/admin/anacare/horas/:patientId`).
 * O ID da URL é sempre o ID INTERNO do paciente (nunca o ID do Ana Care — spec §Contrato de dados
 * da tela, "URL só com o ID interno do paciente"; aqui, como F2/F4 ainda não vinculam paciente
 * real, o `patientId` da rota é o mesmo `AnaCarePatient.anaCareId` que a lista já usa como chave —
 * não há id interno resolvido nesta fase).
 */
import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnaCareHoursDetailContainer } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursDetailContainer';
import { AnaCareHoursExportHttpService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursExportHttpService';
import { AnaCareHoursHttpService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursHttpService';
import { AxonicoComprobanteHttpService } from '@presentation/components/features/admin/AnaCareHours/AxonicoComprobanteHttpService';
import { AnaCarePatientDocumentHttpService } from '@presentation/components/features/admin/AnaCareHours/AnaCarePatientDocumentHttpService';
import { parseMonthParam } from '@presentation/components/features/admin/AnaCareHours/selectors';

export default function AnaCareHoursPatientPage(): JSX.Element | null {
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const service = useMemo(() => new AnaCareHoursHttpService(), []);
  // Envio ao Axonico (19/09) — serviço PRÓPRIO, rota/domínio diferentes de `AnaCareHoursHttpService` (ver `AxonicoComprobanteHttpService.ts`).
  const axonicoService = useMemo(() => new AxonicoComprobanteHttpService(), []);
  // Registro do documento do paciente (19/09) — serviço PRÓPRIO, domínio "integração com o Ana Care" (não Axonico, não `anacare-hours`).
  const patientDocumentService = useMemo(() => new AnaCarePatientDocumentHttpService(), []);
  // Exportação (spec 032) — serviço PRÓPRIO (download do xlsx), mesmo racional dos acima.
  const exportService = useMemo(() => new AnaCareHoursExportHttpService(), []);
  // Mês = `?month` da URL (spec 037), validado; ausente/inválido = MÊS CORRENTE (decisão do Gabriel, 20/09/2026) — nunca cravado em código.
  const [searchParams, setSearchParams] = useSearchParams();
  const month = parseMonthParam(searchParams.get('month'));

  if (!patientId) return null;

  return (
    <AnaCareHoursDetailContainer
      service={service}
      axonicoService={axonicoService}
      patientDocumentService={patientDocumentService}
      exportService={exportService}
      month={month}
      patientId={patientId}
      onMonthChange={(next) => setSearchParams({ month: next }, { replace: true })}
      onSwitchPatient={(id) => navigate(`/admin/anacare/horas/${encodeURIComponent(id)}?month=${month}`)}
      onBack={() => navigate(`/admin/anacare/horas?month=${month}`)}
    />
  );
}
