/**
 * Página-rota da lista de conferência de horas do Ana Care (`/admin/anacare/horas`). Injeta o
 * serviço HTTP real (`AnaCareHoursHttpService`) no `AnaCareHoursListContainer` — a única linha
 * que muda entre teste (Fake) e produção (HTTP), como o README do protótipo prevê.
 *
 * Spec 037: o mês da lista vive na URL (`?month=YYYY-MM`, validado por `parseMonthParam`; troca do
 * seletor SUBSTITUI a entrada do histórico) e é repassado ao abrir um paciente.
 */
import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AnaCareHoursListContainer } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursListContainer';
import { AnaCareHoursHttpService } from '@presentation/components/features/admin/AnaCareHours/AnaCareHoursHttpService';
import { parseMonthParam } from '@presentation/components/features/admin/AnaCareHours/selectors';

export default function AnaCareHoursPage(): JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const service = useMemo(() => new AnaCareHoursHttpService(), []);
  const month = parseMonthParam(searchParams.get('month'));

  return (
    <AnaCareHoursListContainer
      service={service}
      initialMonth={month}
      onMonthChange={(next) => setSearchParams({ month: next }, { replace: true })}
      onOpenPatient={(patientId) => navigate(`/admin/anacare/horas/${patientId}?month=${month}`)}
    />
  );
}
