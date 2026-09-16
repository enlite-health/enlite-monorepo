/**
 * Página-rota da lista de conferência de horas do Ana Care (`/admin/anacare/horas`). Injeta o
 * serviço HTTP real (`AnaCareHoursHttpService`) no `AnaCareHoursListContainer` — a única linha
 * que muda entre teste (Fake) e produção (HTTP), como o README do protótipo prevê.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnaCareHoursListContainer } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursListContainer';
import { AnaCareHoursHttpService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursHttpService';

export default function AnaCareHoursPage(): JSX.Element {
  const navigate = useNavigate();
  const service = useMemo(() => new AnaCareHoursHttpService(), []);

  return <AnaCareHoursListContainer service={service} onOpenPatient={(patientId) => navigate(`/admin/anacare/horas/${patientId}`)} />;
}
