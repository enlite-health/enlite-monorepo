/**
 * VacancyDetailPage — F4 de vaga-le-do-servico-contratado: o detalhe repassa ao card o paciente do serviço quando
 * o horário é do serviço (`locked_fields` traz `schedule`) e monta a faixa de aviso com os `source_change_notices`
 * do GET; "marcar como atendido" recarrega a vaga. Mesmo harness do `.gate.test.tsx` (cards dublados).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockRefetch = vi.fn();
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual('react-router-dom')),
  useParams: () => ({ id: 'v-1' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@hooks/admin/useVacancyDetail', () => ({ useVacancyDetail: vi.fn() }));
vi.mock('@presentation/components/ui/skeletons', () => ({ DetailSkeleton: () => <div /> }));

vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyCaseCard', () => ({ VacancyCaseCard: () => <div /> }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyPatientCard', () => ({ VacancyPatientCard: () => <div /> }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyMeetLinksRow', () => ({ VacancyMeetLinksRow: () => null }));
vi.mock('@presentation/components/features/admin/VacancyDetail/Funnel/VacancyFunnelView', () => ({ VacancyFunnelView: () => <div /> }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyScheduleEditModal', () => ({ VacancyScheduleEditModal: () => null }));
vi.mock('@presentation/components/features/admin/VacancyDetail/VacancyProfessionCard', () => ({
  VacancyProfessionCard: (p: { scheduleServicePatientId?: string | null }) => (
    <div data-testid="profession-card-stub">{p.scheduleServicePatientId ?? 'manual'}</div>
  ),
}));

let ackImpl: () => Promise<void> = async () => undefined;
const ackCalls: Array<[string, string]> = [];
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    acknowledgeVacancySourceChangeNotice: (id: string, field: string) => {
      ackCalls.push([id, field]);
      return ackImpl();
    },
    updateVacancy: vi.fn(),
  },
}));

import { useVacancyDetail } from '@hooks/admin/useVacancyDetail';
import VacancyDetailPage from '../VacancyDetailPage';

const vacancy = (extra: Record<string, unknown>) => ({
  id: 'v-1', status: 'BUSQUEDA', is_draft: false, case_number: 1, vacancy_number: 1, patient_id: 'p-9',
  encuadres: [], publications: [], required_professions: ['AT'], ...extra,
});
const mount = (extra: Record<string, unknown>) => {
  vi.mocked(useVacancyDetail).mockReturnValue({ vacancy: vacancy(extra) as never, isLoading: false, error: null, refetch: mockRefetch });
  return render(<MemoryRouter><VacancyDetailPage /></MemoryRouter>);
};

beforeEach(() => {
  mockRefetch.mockReset();
  ackCalls.length = 0;
  ackImpl = async () => undefined;
});

describe('VacancyDetailPage — horário vindo do serviço contratado', () => {
  it('locked_fields com schedule → o card recebe o paciente (lápis vira link)', () => {
    mount({ locked_fields: ['patient_id', 'schedule'] });
    expect(screen.getByTestId('profession-card-stub')).toHaveTextContent('p-9');
  });

  it('vaga manual (sem locked_fields ou sem schedule neles) → o card não recebe paciente (lápis = modal)', () => {
    const { unmount } = mount({ locked_fields: [] });
    expect(screen.getByTestId('profession-card-stub')).toHaveTextContent('manual');
    unmount();
    mount({ locked_fields: ['patient_id', 'providers_needed'] });
    expect(screen.getByTestId('profession-card-stub')).toHaveTextContent('manual');
  });

  it('sem avisos abertos → nenhuma faixa', () => {
    mount({ locked_fields: ['schedule'], source_change_notices: [] });
    expect(screen.queryByTestId('source-change-notice-banner')).not.toBeInTheDocument();
  });

  it('com aviso aberto → faixa por campo; "marcar como atendido" chama o POST, some a faixa e recarrega a vaga', async () => {
    mount({ locked_fields: ['schedule'], source_change_notices: [{ field: 'schedule', changed_at: '2026-10-10T15:00:00.000Z' }] });
    expect(screen.getByTestId('source-change-notice-schedule')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('source-change-notice-ack-schedule'));
    await waitFor(() => expect(screen.queryByTestId('source-change-notice-banner')).not.toBeInTheDocument());
    expect(ackCalls).toEqual([['v-1', 'schedule']]);
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });
});
