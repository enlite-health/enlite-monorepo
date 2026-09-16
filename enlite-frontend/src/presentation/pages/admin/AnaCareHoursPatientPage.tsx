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

const CURRENT_MONTH = '2026-08';

export default function AnaCareHoursPatientPage(): JSX.Element | null {
  const navigate = useNavigate();
  const { patientId } = useParams<{ patientId: string }>();
  const service = useMemo(() => new AnaCareHoursHttpService(), []);

  if (!patientId) return null;

  return (
    <AnaCareHoursDetailContainer
      service={service}
      month={CURRENT_MONTH}
      patientId={patientId}
      onBack={() => navigate('/admin/anacare/horas')}
    />
  );
}
