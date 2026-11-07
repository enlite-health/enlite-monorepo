import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import VacancyInvitePage from '../VacancyInvitePage';
import { useInviteProgressStore } from '@presentation/stores/inviteProgressStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: unknown) => (o && typeof o === 'object' ? `${k}${JSON.stringify(o)}` : k), i18n: { language: 'es' } }),
}));

const board = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const detail = vi.hoisted(() => ({ value: {} as Record<string, unknown>, calledWith: vi.fn() }));
const gates = vi.hoisted(() => ({ allowed: { 'match:read': true, 'match:execute': true } as Record<string, boolean> }));

vi.mock('@hooks/admin/useVacancyInviteBoard', () => ({ useVacancyInviteBoard: () => board.value }));
vi.mock('@hooks/admin/useVacancyDetail', () => ({
  useVacancyDetail: (id: string | undefined) => { detail.calledWith(id); return detail.value; },
}));
vi.mock('@presentation/hooks/useCellAccess', () => ({
  useActionGate: (r: string, a: string) => ({ allowed: gates.allowed[`${r}:${a}`] ?? true, denied: false }),
}));
vi.mock('@presentation/components/molecules/PointsMap/PointsMap', () => ({
  PointsMap: (p: {
    rings?: unknown[]; fitRadiusKm?: number; points: Array<{ id: string; style?: { sizePx: number } }>;
    hoveredId?: string | null; selectedId?: string | null;
    onHover?: (id: string | null) => void; onSelect?: (id: string | null) => void;
  }) => (
    <div data-testid="points-map-stub" data-rings={p.rings?.length} data-fit={p.fitRadiusKm} data-hovered={p.hoveredId ?? ''} data-selected={p.selectedId ?? ''}>
      {p.points.map((pt) => (
        <button key={pt.id} type="button" data-testid={`pin-${pt.id}`} data-size={pt.style?.sizePx}
          onMouseEnter={() => p.onHover?.(pt.id)} onMouseLeave={() => p.onHover?.(null)} onClick={() => p.onSelect?.(pt.id)} />
      ))}
    </div>
  ),
}));

const cand = (id: string, d: number | null, extra = {}) => ({
  workerId: id, workerName: id, workerPhone: null, occupation: 'AT', workZone: null, distanceKm: d, lat: -34.6, lng: -58.4,
  activeCasesCount: 0, workerStatus: null, documentStatus: 'approved', source: 'system', funnelStage: 'INVITED', replied: false,
  matchScore: null, internalNotes: null, alreadyApplied: false, messagedAt: null, ...extra,
});
const ready = (candidates: unknown[], ids: string[]) => ({
  status: 'ready', error: null, isRefreshing: false, refetch: vi.fn(), reload: vi.fn(), currentIds: new Set(ids),
  results: { jobPostingId: 'v1', operationDate: '2026-11-06', service: { lat: -34.6, lng: -58.4, addressLabel: 'X' }, candidates },
});

function Probe() { const l = useLocation(); return <div data-testid="loc">{l.pathname + l.search}</div>; }
function renderPage(entry: unknown = '/admin/vacancies/v1/match') {
  return render(
    <MemoryRouter initialEntries={[entry as string]}>
      <Probe />
      <Routes>
        <Route path="/admin/vacancies/:id/match" element={<VacancyInvitePage />} />
        <Route path="/admin/vacancies/:id" element={<div data-testid="detail" />} />
        <Route path="/admin/vacancies/:id/borrador" element={<div data-testid="draft" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useInviteProgressStore.setState({ isSending: false });
  gates.allowed = { 'match:read': true, 'match:execute': true };
  detail.value = { vacancy: { id: 'v1', status: 'ACTIVE', case_number: 817, vacancy_number: 2, required_sex: 'F', required_professions: ['AT'], patient_address_formatted: 'Av. Santa Fe 3200' }, error: null };
  board.value = ready([cand('a', 3), cand('b', 7)], ['a', 'b']);
});

describe('VacancyInvitePage (T026a)', () => {
  it('carregando: F1 com role=status e esqueleto da lista', () => {
    board.value = { ...ready([], []), status: 'loading', results: null };
    renderPage();
    expect(screen.getByTestId('invite-loading-status')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('invite-list-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('points-map-stub')).toBeNull();
  });

  it('pronto: cabeçalho + mapa com anéis e passo gravado em ?paso= (replace)', async () => {
    renderPage();
    expect(screen.getByTestId('invite-title')).toHaveTextContent('admin.vacancyInvite.title');
    expect(screen.getByTestId('invite-subtitle')).toBeInTheDocument();
    expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-fit', '5');
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('?paso=5'));
  });

  it('?paso=vacante válido vence a regra de abertura', () => {
    renderPage('/admin/vacancies/v1/match?paso=vacante');
    expect(screen.getByTestId('invite-page')).toHaveAttribute('data-step', 'vacante');
    expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-rings', '4');
  });

  it('Volver com state.from → navigate(-1); sem state → vacante ?tab=encuadres', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={[{ pathname: '/admin/vacancies/v1', search: '?tab=talentum' }, { pathname: '/admin/vacancies/v1/match', state: { from: '/admin/vacancies/v1?tab=talentum' } }]} initialIndex={1}>
        <Probe />
        <Routes>
          <Route path="/admin/vacancies/:id/match" element={<VacancyInvitePage />} />
          <Route path="/admin/vacancies/:id" element={<div />} />
        </Routes>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByTestId('invite-back'));
    expect(screen.getByTestId('loc')).toHaveTextContent('/admin/vacancies/v1?tab=talentum');
    unmount();
    renderPage();
    await userEvent.click(screen.getByTestId('invite-back'));
    expect(screen.getByTestId('loc')).toHaveTextContent('/admin/vacancies/v1?tab=encuadres');
  });

  it('rascunho → Navigate para /borrador', () => {
    detail.value = { vacancy: { id: 'v1', is_draft: true }, error: null };
    board.value = { ...ready([], []), status: 'idle', results: null };
    renderPage();
    expect(screen.getByTestId('draft')).toBeInTheDocument();
  });

  it('DE_BAJA → estado próprio, sem mapa', () => {
    detail.value = { vacancy: { id: 'v1', status: 'DE_BAJA' }, error: null };
    board.value = { ...ready([], []), status: 'idle', results: null };
    renderPage();
    expect(screen.getByTestId('invite-de-baja')).toBeInTheDocument();
    expect(screen.queryByTestId('points-map-stub')).toBeNull();
  });

  it('sem match:read: "Sin permiso" e a vacante nem é pedida (0 request)', () => {
    gates.allowed['match:read'] = false;
    renderPage();
    expect(screen.getByTestId('invite-no-permission')).toBeInTheDocument();
    expect(detail.calledWith).toHaveBeenCalledWith(undefined);
  });

  it('CA-9: beforeunload só com isSending', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    renderPage();
    expect(add.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(false);
    act(() => useInviteProgressStore.setState({ isSending: true }));
    expect(add.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true);
    act(() => useInviteProgressStore.setState({ isSending: false }));
    expect(remove.mock.calls.some((c) => c[0] === 'beforeunload')).toBe(true);
    add.mockRestore(); remove.mockRestore();
  });

  it('RF-11: hover na linha engorda o pino; hover no pino acende a linha; clique no pino foca a linha; clique no nome abre/fecha o pino', async () => {
    board.value = ready([cand('a', 2), cand('b', 4)], ['a', 'b']);
    renderPage('/admin/vacancies/v1/match?paso=5');
    await userEvent.hover(screen.getByTestId('invite-row-a'));
    expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-hovered', 'a');
    expect(screen.getByTestId('pin-a')).toHaveAttribute('data-size', '24');
    await userEvent.unhover(screen.getByTestId('invite-row-a'));
    await userEvent.hover(screen.getByTestId('pin-b'));
    expect(screen.getByTestId('invite-row-b')).toHaveAttribute('data-highlighted', 'true');
    await userEvent.click(screen.getByTestId('pin-b'));
    expect(screen.getByTestId('invite-row-b')).toHaveAttribute('data-focused', 'true');
    expect(screen.getByTestId('invite-row-name-b')).toHaveFocus();
    await userEvent.click(screen.getByTestId('invite-row-name-a'));
    expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-selected', 'a');
    await userEvent.click(screen.getByTestId('invite-row-name-a'));
    expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-selected', '');
  });

  it('seleção: desmarcar 1 linha → "1 de 2", rodapé "Invitar a 1"; "Todos" re-marca', async () => {
    board.value = ready([cand('a', 2), cand('b', 4)], ['a', 'b']);
    renderPage('/admin/vacancies/v1/match?paso=5');
    expect(screen.getByTestId('invite-counter')).toHaveTextContent('"selected":2,"pending":2');
    await userEvent.click(screen.getByTestId('invite-row-check-a'));
    expect(screen.getByTestId('invite-counter')).toHaveTextContent('"selected":1,"pending":2');
    expect(screen.getByTestId('invite-btn-invite')).toHaveTextContent('"count":1');
    await userEvent.click(screen.getByTestId('invite-select-all'));
    expect(screen.getByTestId('invite-counter')).toHaveTextContent('"selected":2,"pending":2');
  });

  it('interruptor de documentos: esconde quem falta, desmarca, e desligar NÃO re-seleciona (DF-17)', async () => {
    board.value = ready([cand('a', 3, { documentStatus: 'pending' }), cand('b', 4)], ['a', 'b']);
    renderPage('/admin/vacancies/v1/match?paso=5');
    await userEvent.click(screen.getByRole('switch'));
    expect(screen.queryByTestId('invite-row-a')).toBeNull();
    expect(screen.getByTestId('invite-docs-line')).toHaveTextContent('docs.on');
    await userEvent.click(screen.getByRole('switch'));
    expect(screen.getByTestId('invite-row-check-a')).not.toBeChecked();
    expect(screen.getByTestId('invite-row-check-b')).toBeChecked();
  });

  it('trocar de passo (cartão e "Buscar más lejos") grava ?paso= sem tocar no dado', async () => {
    renderPage('/admin/vacancies/v1/match?paso=5');
    await userEvent.click(screen.getByTestId('invite-step-20'));
    expect(screen.getByTestId('loc')).toHaveTextContent('?paso=20');
    await userEvent.click(screen.getByTestId('invite-step-5'));
    await userEvent.click(screen.getByTestId('invite-btn-more-secondary'));
    expect(screen.getByTestId('loc')).toHaveTextContent('?paso=10');
    expect(board.value.refetch).not.toHaveBeenCalled();
    expect(board.value.reload).not.toHaveBeenCalled();
  });

  it('passo vacante: nota amarela com os 2 contadores e sem a nota do perfil (⚑7)', () => {
    board.value = ready([cand('a', 3), cand('far', 61, { source: 'manual' }), cand('nl', null, { source: 'manual', lat: null, lng: null })], ['a']);
    renderPage('/admin/vacancies/v1/match?paso=vacante');
    expect(screen.getByTestId('invite-vacante-note')).toHaveTextContent('vacanteNote.far{"count":1}');
    expect(screen.getByTestId('invite-vacante-note')).toHaveTextContent('vacanteNote.noLocation{"count":1}');
    expect(screen.queryByTestId('invite-profile-note')).toBeNull();
    expect(screen.getByTestId('invite-map-legend')).toBeInTheDocument();
  });
});
