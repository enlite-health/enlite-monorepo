/**
 * Convite de 221 pessoas travava a página: cada patch da fila re-renderizava todas as linhas e refazia
 * o desenho do passo. Aqui o contrato: o patch de UM item redesenha só a linha dele, o mapa recebe os
 * MESMOS `points`, e o erro do GET pós-envio aparece na tela.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import VacancyInvitePage from '../VacancyInvitePage';
import { useInviteProgressStore } from '@presentation/stores/inviteProgressStore';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

// `t` com identidade estável, como no i18next real (só muda com o idioma).
const tr = vi.hoisted(() => ({ t: (k: string, o?: unknown) => (o && typeof o === 'object' ? `${k}${JSON.stringify(o)}` : k) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tr.t, i18n: { language: 'es' } }) }));

const board = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const renders = vi.hoisted(() => ({ avatar: {} as Record<string, number>, pointsRefs: [] as unknown[] }));

vi.mock('@hooks/admin/useVacancyInviteBoard', () => ({ useVacancyInviteBoard: () => board.value }));
vi.mock('@hooks/admin/useVacancyDetail', () => ({
  useVacancyDetail: () => ({ vacancy: { id: 'v1', status: 'ACTIVE', case_number: 817, vacancy_number: 2 }, error: null }),
}));
vi.mock('@presentation/hooks/useCellAccess', () => ({ useActionGate: () => ({ allowed: true, denied: false }) }));
vi.mock('@presentation/components/molecules/PointsMap/PointsMap', () => ({
  PointsMap: (p: { points: unknown }) => { renders.pointsRefs.push(p.points); return <div data-testid="points-map-stub" />; },
}));
// Cada render de `InviteRow` desenha o avatar uma vez: é o contador de render por linha.
vi.mock('@presentation/components/atoms/WorkerAvatar', () => ({
  WorkerAvatar: ({ name }: { name: string }) => { renders.avatar[name] = (renders.avatar[name] ?? 0) + 1; return <span />; },
}));

const cand = (id: string, d: number) => ({
  workerId: id, workerName: id, workerPhone: null, occupation: 'AT', workZone: null, distanceKm: d, lat: -34.6, lng: -58.4,
  activeCasesCount: 0, workerStatus: null, documentStatus: 'approved', source: 'system', funnelStage: 'INVITED', replied: false,
  matchScore: null, internalNotes: null, alreadyApplied: false, messagedAt: null,
});
const ready = (error: string | null = null) => ({
  status: 'ready', error, isRefreshing: false, refetch: vi.fn().mockResolvedValue(true), reload: vi.fn(), currentIds: new Set(['a', 'b', 'c']),
  results: { jobPostingId: 'v1', operationDate: '2026-11-06', service: { lat: -34.6, lng: -58.4, addressLabel: 'X' }, candidates: [cand('a', 3), cand('b', 4), cand('c', 5)] },
});
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/vacancies/v1/match']}>
      <Routes><Route path="/admin/vacancies/:id/match" element={<VacancyInvitePage />} /></Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  renders.avatar = {};
  renders.pointsRefs = [];
  useInviteProgressStore.setState({ isSending: false, items: [] });
  board.value = ready();
});

describe('VacancyInvitePage — envio em lote não redesenha a página inteira', () => {
  it('patch de 1 item na fila: só a linha dele re-renderiza e o mapa recebe os mesmos points', () => {
    renderPage();
    const before = { ...renders.avatar };
    const pointsBefore = renders.pointsRefs[renders.pointsRefs.length - 1];
    expect(before).toEqual({ a: 1, b: 1, c: 1 });

    act(() => useInviteProgressStore.setState({
      isSending: true,
      items: [{ vacancyId: 'v1', workerId: 'a', workerName: 'a', status: 'sending' }],
    }));

    expect(renders.avatar.a).toBe(2); // a linha em envio mostra "Enviando…"
    expect(renders.avatar.b).toBe(1); // as outras NÃO re-renderizam
    expect(renders.avatar.c).toBe(1);
    expect(renders.pointsRefs[renders.pointsRefs.length - 1]).toBe(pointsBefore);
  });
});

describe('VacancyInvitePage — erro do GET pós-envio', () => {
  it('status ready + error: mostra o alerta não bloqueante e mantém a lista', () => {
    board.value = ready('boom');
    renderPage();
    const box = screen.getByTestId('invite-refresh-error');
    expect(box.querySelector('[role="alert"]')).toHaveTextContent('admin.vacancyInvite.error.refresh');
    expect(screen.getByTestId('invite-row-a')).toBeInTheDocument();
  });

  it('sem erro: nenhum alerta', () => {
    renderPage();
    expect(screen.queryByTestId('invite-refresh-error')).toBeNull();
  });

  it('a mensagem existe em es e pt-BR (texto fixo é defeito)', () => {
    const pick = (l: unknown) => (l as { admin: { vacancyInvite: { error: { refresh?: string } } } }).admin.vacancyInvite.error.refresh;
    expect(pick(es)).toMatch(/actualizar la lista/);
    expect(pick(ptBR)).toMatch(/atualizar a lista/);
  });
});
