/**
 * Página-rota do detalhe de paciente da conferência de horas (`/admin/anacare/horas/:patientId`).
 * O ID da URL é sempre o ID INTERNO do paciente (nunca o ID do Ana Care — spec §Contrato de dados
 * da tela, "URL só com o ID interno do paciente"; aqui, como F2/F4 ainda não vinculam paciente
 * real, o `patientId` da rota é o mesmo `AnaCarePatient.anaCareId` que a lista já usa como chave —
 * não há id interno resolvido nesta fase).
 */
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnaCareHoursDetailContainer } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursDetailContainer';
import { AnaCareHoursHttpService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursHttpService';
import { AxonicoComprobanteHttpService } from '@presentation/components/features/admin/AnaCareHours/AxonicoComprobanteHttpService';
import { previousMonthIso } from '@presentation/components/features/admin/AnaCareHours/selectors';

export default function AnaCareHoursPatientPage(): JSX.Element | null {
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const service = useMemo(() => new AnaCareHoursHttpService(), []);
  // Envio ao Axonico (19/09) — serviço PRÓPRIO, rota/domínio diferentes de `AnaCareHoursHttpService` (ver `AxonicoComprobanteHttpService.ts`).
  const axonicoService = useMemo(() => new AxonicoComprobanteHttpService(), []);
  // Mês padrão = MÊS ANTERIOR ao atual (decisão do Gabriel, 16/09) — nunca cravado em código.
  const month = useMemo(() => previousMonthIso(), []);

  if (!patientId) return null;

  return (
    <AnaCareHoursDetailContainer
      service={service}
      axonicoService={axonicoService}
      month={month}
      patientId={patientId}
      onBack={() => navigate('/admin/anacare/horas')}
    />
  );
}
