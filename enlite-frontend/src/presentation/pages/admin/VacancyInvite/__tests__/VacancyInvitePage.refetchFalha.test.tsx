/**
 * Fim do envio: o GET de atualização falhou. O `localMessaged` (transitório) é o ÚNICO jeito de o
 * recém-convidado continuar "Invitado hoy"; limpá-lo com o GET falho devolvia a pessoa a "por invitar"
 * e marcada por padrão (risco de convidar de novo).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import VacancyInvitePage from '../VacancyInvitePage';
import { useInviteProgressStore } from '@presentation/stores/inviteProgressStore';
import { dayInZone } from '../inviteBoardCore';

const tr = vi.hoisted(() => ({ t: (k: string, o?: unknown) => (o && typeof o === 'object' ? `${k}${JSON.stringify(o)}` : k) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tr.t, i18n: { language: 'es' } }) }));

const board = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('@hooks/admin/useVacancyInviteBoard', () => ({ useVacancyInviteBoard: () => board.value }));
vi.mock('@hooks/admin/useVacancyDetail', () => ({
  useVacancyDetail: () => ({ vacancy: { id: 'v1', status: 'ACTIVE', case_number: 817, vacancy_number: 2 }, error: null }),
}));
vi.mock('@presentation/hooks/useCellAccess', () => ({ useActionGate: () => ({ allowed: true, denied: false }) }));
vi.mock('@presentation/components/molecules/PointsMap/PointsMap', () => ({ PointsMap: () => <div data-testid="points-map-stub" /> }));

const realEnqueue = useInviteProgressStore.getState().enqueue;
const cand = (id: string, d: number) => ({
  workerId: id, workerName: id, workerPhone: null, occupation: 'AT', workZone: null, distanceKm: d, lat: -34.6, lng: -58.4,
  activeCasesCount: 0, workerStatus: null, documentStatus: 'approved', source: 'system', funnelStage: 'INVITED', replied: false,
  matchScore: null, internalNotes: null, alreadyApplied: false, messagedAt: null,
});
const ready = (refetch: () => Promise<boolean>) => ({
  status: 'ready', error: null, isRefreshing: false, refetch, reload: vi.fn(), currentIds: new Set(['a', 'b']),
  results: { jobPostingId: 'v1', operationDate: dayInZone(new Date().toISOString()) as string, service: { lat: -34.6, lng: -58.4, addressLabel: 'X' }, candidates: [cand('a', 2), cand('b', 3)] },
});

async function inviteAndFinish(): Promise<void> {
  // A fila fake: marca "a" como enviado (callback de messagedAt) e liga o `isSending`.
  useInviteProgressStore.setState({
    enqueue: (_v: string, _t: unknown, cb?: (id: string, at: string) => void) => {
      cb?.('a', new Date().toISOString());
      useInviteProgressStore.setState({ isSending: true, items: [] });
    },
  });
  render(
    <MemoryRouter initialEntries={['/admin/vacancies/v1/match?paso=5']}>
      <Routes><Route path="/admin/vacancies/:id/match" element={<VacancyInvitePage />} /></Routes>
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByTestId('invite-row-check-b')); // só "a" vai
  await userEvent.click(screen.getByTestId('invite-btn-invite'));
  await userEvent.click(screen.getByTestId('invite-confirm-send'));
  act(() => useInviteProgressStore.setState({ isSending: false }));
}

beforeEach(() => {
  useInviteProgressStore.setState({ isSending: false, items: [], enqueue: realEnqueue });
});

describe('fim do envio com o GET de atualização', () => {
  it('GET falhou (refetch → false): "a" continua "Invitado hoy" e NÃO selecionado', async () => {
    const refetch = vi.fn().mockResolvedValue(false);
    board.value = ready(refetch);
    await inviteAndFinish();
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('invite-row-badge-a')).toHaveTextContent('admin.vacancyInvite.row.invitedToday');
    expect(screen.getByTestId('invite-row-a')).toHaveAttribute('data-selected', 'false');
  });

  it('GET ok (refetch → true): o transitório é descartado (o servidor passa a mandar)', async () => {
    const refetch = vi.fn().mockResolvedValue(true);
    board.value = ready(refetch);
    await inviteAndFinish();
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('invite-row-badge-a')).not.toHaveTextContent('invitedToday'));
  });
});
