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
const gates = vi.hoisted(() => ({ allowed: { 'match:read': true, 'match:execute': true, 'messaging:send': true } as Record<string, boolean> }));

vi.mock('@hooks/admin/useVacancyInviteBoard', () => ({ useVacancyInviteBoard: () => board.value }));
vi.mock('@hooks/admin/useVacancyDetail', () => ({
  useVacancyDetail: (id: string | undefined) => { detail.calledWith(id); return detail.value; },
}));
vi.mock('@presentation/hooks/useCellAccess', () => ({
  useActionGate: (r: string, a: string) => ({ allowed: gates.allowed[`${r}:${a}`] ?? true, denied: false }),
}));
vi.mock('@presentation/components/molecules/PointsMap/PointsMap', () => ({
  PointsMap: (p: {
    rings?: unknown[]; fitRadiusKm?: number; centerLabel?: string; points: Array<{ id: string; tooltip?: string; style?: { sizePx: number } }>;
    hoveredId?: string | null; selectedId?: string | null;
    onHover?: (id: string | null) => void; onSelect?: (id: string | null) => void;
  }) => (
    <div data-testid="points-map-stub" data-rings={p.rings?.length} data-fit={p.fitRadiusKm} data-hovered={p.hoveredId ?? ''} data-selected={p.selectedId ?? ''} data-center-label={p.centerLabel}>
      {p.points.map((pt) => (
        <button key={pt.id} type="button" data-testid={`pin-${pt.id}`} data-size={pt.style?.sizePx} data-tooltip={pt.tooltip}
          onMouseEnter={() => p.onHover?.(pt.id)} onMouseLeave={() => p.onHover?.(null)} onClick={() => p.onSelect?.(pt.id)} />
      ))}
    </div>
  ),
}));

const realEnqueue = useInviteProgressStore.getState().enqueue;
const cand = (id: string, d: number | null, extra = {}) => ({
  workerId: id, workerName: id, workerPhone: null, occupation: 'AT', workZone: null, distanceKm: d, lat: -34.6, lng: -58.4,
  activeCasesCount: 0, workerStatus: null, documentStatus: 'approved', source: 'system', funnelStage: 'INVITED', replied: false,
  matchScore: null, internalNotes: null, alreadyApplied: false, messagedAt: null, ...extra,
});
const ready = (candidates: unknown[], ids: string[]) => ({
  status: 'ready', error: null, isRefreshing: false, refetch: vi.fn().mockResolvedValue(undefined), reload: vi.fn(), currentIds: new Set(ids),
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
  useInviteProgressStore.setState({ isSending: false, items: [], enqueue: realEnqueue });
  gates.allowed = { 'match:read': true, 'match:execute': true, 'messaging:send': true };
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
    await waitFor(() => expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-hovered', 'a'));
    await waitFor(() => expect(screen.getByTestId('pin-a')).toHaveAttribute('data-size', '24'));
    await userEvent.unhover(screen.getByTestId('invite-row-a'));
    await userEvent.hover(screen.getByTestId('pin-b'));
    await waitFor(() => expect(screen.getByTestId('invite-row-b')).toHaveAttribute('data-highlighted', 'true'));
    await userEvent.click(screen.getByTestId('pin-b'));
    await waitFor(() => expect(screen.getByTestId('invite-row-b')).toHaveAttribute('data-focused', 'true'));
    await waitFor(() => expect(screen.getByTestId('invite-row-name-b')).toHaveFocus());
    await userEvent.click(screen.getByTestId('invite-row-name-a'));
    await waitFor(() => expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-selected', 'a'));
    await userEvent.click(screen.getByTestId('invite-row-name-a'));
    await waitFor(() => expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-selected', ''));
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
    // sem pinos mas fora do E8: a legenda fica (só some em "ninguém até 50 km"); no passo vacante sem dica
    expect(screen.getByTestId('invite-map-legend')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-map-hint')).toBeNull();
  });

  it('com pino: legenda sempre; dica "Tocá un punto…" só fora do passo vacante (a nota amarela ocupa o topo) (089 C)', () => {
    board.value = ready([cand('a', 3), cand('near', 23, { source: 'manual' })], ['a']);
    const { unmount } = renderPage('/admin/vacancies/v1/match?paso=vacante');
    expect(screen.getByTestId('invite-map-legend')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-map-hint')).toBeNull();
    unmount();
    renderPage('/admin/vacancies/v1/match?paso=5');
    expect(screen.getByTestId('invite-map-legend')).toBeInTheDocument();
    expect(screen.getByTestId('invite-map-hint')).toBeInTheDocument();
  });

  describe('envio (T026c)', () => {
    const open5 = () => renderPage('/admin/vacancies/v1/match?paso=5');

    it('F3: Invitar abre a confirmação com os elegidos; "No, volver" fecha sem enfileirar', async () => {
      const enqueue = vi.fn();
      useInviteProgressStore.setState({ enqueue });
      board.value = ready([cand('a', 2), cand('b', 4), cand('c', 4.5)], ['a', 'b', 'c']);
      open5();
      await userEvent.click(screen.getByTestId('invite-row-check-c'));
      await userEvent.click(screen.getByTestId('invite-btn-invite'));
      const dlg = screen.getByRole('dialog');
      expect(dlg).toHaveAttribute('aria-modal', 'true');
      expect(screen.getByTestId('invite-confirm-lead')).toHaveTextContent('"count":2');
      expect(screen.getByTestId('invite-confirm-item-a')).toHaveTextContent('"value":"2,0"');
      expect(screen.queryByTestId('invite-confirm-item-c')).toBeNull();
      expect(screen.queryByTestId('invite-confirm-already')).toBeNull();
      await userEvent.click(screen.getByTestId('invite-confirm-cancel'));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('confirmar enfileira só os elegidos, SEM resend; o já convidado só entra com a caixa (resend:true)', async () => {
      const enqueue = vi.fn();
      useInviteProgressStore.setState({ enqueue });
      board.value = ready([cand('a', 2), cand('old', 3, { messagedAt: '2026-11-03T15:00:00Z' })], ['a', 'old']);
      open5();
      await userEvent.click(screen.getByTestId('invite-btn-invite'));
      expect(screen.getByTestId('invite-confirm-already')).toHaveTextContent('"date":"03/11"');
      expect(screen.getByTestId('invite-confirm-resend')).not.toBeChecked();
      await userEvent.click(screen.getByTestId('invite-confirm-send'));
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue.mock.calls[0][1]).toEqual([{ workerId: 'a', workerName: 'Nome a'.replace('Nome a', 'a'), messagedAt: null }]);
      await userEvent.click(screen.getByTestId('invite-btn-invite'));
      await userEvent.click(screen.getByTestId('invite-confirm-resend'));
      expect(screen.getByTestId('invite-confirm-send')).toHaveTextContent('"count":2');
      await userEvent.click(screen.getByTestId('invite-confirm-send'));
      expect(enqueue.mock.calls[1][1]).toEqual([
        { workerId: 'a', workerName: 'a', messagedAt: null },
        { workerId: 'old', workerName: 'old', messagedAt: '2026-11-03T15:00:00Z', resend: true },
      ]);
    });

    it('F4/DF-19: ao terminar o envio, alerta só com quem saiu + "M no se enviaron", 1 GET (refetch), linha do erro', async () => {
      const refetch = vi.fn().mockResolvedValue(undefined);
      board.value = { ...ready([cand('a', 2), cand('b', 4)], ['a', 'b']), refetch };
      useInviteProgressStore.setState({ enqueue: () => undefined });
      open5();
      await userEvent.click(screen.getByTestId('invite-btn-invite'));
      await userEvent.click(screen.getByTestId('invite-confirm-send'));
      act(() => useInviteProgressStore.setState({ isSending: true, items: [
        { vacancyId: 'v1', workerId: 'a', workerName: 'a', status: 'sending' },
        { vacancyId: 'v1', workerId: 'b', workerName: 'b', status: 'pending' },
      ] }));
      expect(screen.getByTestId('invite-row-badge-b')).toHaveTextContent('row.sending');
      expect(refetch).not.toHaveBeenCalled();
      act(() => useInviteProgressStore.setState({ isSending: false, items: [
        { vacancyId: 'v1', workerId: 'a', workerName: 'a', status: 'sent' },
        { vacancyId: 'v1', workerId: 'b', workerName: 'b', status: 'error', errorCode: 'COOLDOWN' },
      ] }));
      await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('invite-sent-alert')).toHaveAttribute('data-failed', '1');
      expect(screen.getByTestId('invite-sent-alert')).toHaveTextContent('sent.title');
      expect(screen.getByTestId('invite-sent-alert')).toHaveTextContent('"count":1');
      expect(screen.getByTestId('invite-sent-progress')).toHaveTextContent('"sent":1,"total":2');
      expect(screen.getByTestId('invite-sent-failed')).toHaveTextContent('"count":1');
      expect(screen.getByTestId('invite-row-badge-b')).not.toHaveTextContent('row.invitedToday');
      expect(screen.getByTestId('invite-step-5')).toHaveAttribute('data-tone', 'done');
    });
  });

  it('F5: Terminar abre o resumo do servidor; Seguir invitando fecha; Volver volta à vacante (RF-3/RF-4)', async () => {
    board.value = ready([
      cand('a', 2, { messagedAt: '2026-11-06T12:00:00Z' }), cand('b', 7, { messagedAt: '2026-11-06T13:00:00Z' }),
      cand('c', 8), cand('old', 3, { messagedAt: '2026-11-03T12:00:00Z' }),
    ], ['a', 'b', 'c', 'old']);
    renderPage('/admin/vacancies/v1/match?paso=5');
    await userEvent.click(screen.getByTestId('invite-btn-finish-secondary'));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('invite-finish-title')).toHaveTextContent('"count":2');
    expect(screen.getByTestId('invite-finish-row-5')).toHaveTextContent('1');
    expect(screen.getByTestId('invite-finish-row-10')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-finish-row-20')).toBeNull();
    await userEvent.click(screen.getByTestId('invite-finish-keep'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByTestId('invite-btn-finish-secondary'));
    await userEvent.click(screen.getByTestId('invite-finish-back'));
    expect(screen.getByTestId('loc')).toHaveTextContent('/admin/vacancies/v1?tab=encuadres');
  });

  describe('casos especiais e permissão (T026d)', () => {
    it('F6 esquerda: serviço sem coordenada → sem mapa/lista; "Corregir" leva à aba itinerário do serviço (DF-12)', async () => {
      detail.value = { vacancy: { id: 'v1', status: 'ACTIVE', patient_id: 'p1', contracted_service_id: 's1', patient_address_raw: 'Calle X 123' }, error: null };
      board.value = { ...ready([], []), status: 'noService', results: { jobPostingId: 'v1', operationDate: '2026-11-06', service: { lat: null, lng: null, addressLabel: null }, candidates: [] } };
      renderPage();
      expect(screen.getByTestId('invite-special-case')).toHaveAttribute('data-kind', 'no-service');
      expect(screen.getByTestId('invite-no-service-address')).toHaveTextContent('Calle X 123');
      expect(screen.queryByTestId('points-map-stub')).toBeNull();
      expect(screen.queryByTestId('invite-rows')).toBeNull();
      await userEvent.click(screen.getByTestId('invite-special-fix'));
      expect(screen.getByTestId('loc')).toHaveTextContent('/admin/patients/p1?tab=itinerary&serviceId=s1');
    });

    it('F6 direita: ninguém até 50 km; "Ver las N" leva ao passo vacante e some com N=0', async () => {
      board.value = ready([cand('m1', 3, { source: 'manual' }), cand('m2', null, { source: 'manual', lat: null, lng: null })], []);
      const { unmount } = renderPage('/admin/vacancies/v1/match?paso=5');
      expect(screen.getByTestId('invite-special-case')).toHaveAttribute('data-kind', 'nobody');
      expect(screen.getByTestId('invite-nobody-vacante')).toHaveTextContent('"count":2');
      // E8: sem legenda e sem dica no mapa (089 N2)
      expect(screen.queryByTestId('invite-map-legend')).toBeNull();
      expect(screen.queryByTestId('invite-map-hint')).toBeNull();
      expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-rings', '4');
      expect(screen.queryByTestId('pin-m1')).toBeNull();
      await userEvent.click(screen.getByTestId('invite-nobody-see'));
      expect(screen.getByTestId('loc')).toHaveTextContent('?paso=vacante');
      expect(screen.queryByTestId('invite-special-case')).toBeNull();
      expect(screen.getByTestId('invite-row-m1')).toBeInTheDocument();
      unmount();
      board.value = ready([], []);
      renderPage('/admin/vacancies/v1/match?paso=5');
      expect(screen.getByTestId('invite-special-case')).toHaveAttribute('data-kind', 'nobody');
      expect(screen.queryByTestId('invite-nobody-vacante')).toBeNull();
    });

    it('⚑2 sem match:execute: só o passo vacante (a URL com ?paso=10 não leva a outro), sem "buscar más lejos"', () => {
      gates.allowed['match:execute'] = false;
      board.value = ready([cand('m1', 3, { source: 'manual' })], []);
      renderPage('/admin/vacancies/v1/match?paso=10');
      expect(screen.getByTestId('invite-page')).toHaveAttribute('data-step', 'vacante');
      expect(screen.getByTestId('invite-step-vacante')).toBeInTheDocument();
      expect(screen.queryByTestId('invite-step-5')).toBeNull();
      expect(screen.queryByTestId('invite-btn-more-secondary')).toBeNull();
      expect(screen.getByTestId('invite-row-m1')).toBeInTheDocument();
    });

    it('⚑2 sem messaging:send: só-ver — Invitar desabilitado com o motivo no title', () => {
      gates.allowed['messaging:send'] = false;
      renderPage('/admin/vacancies/v1/match?paso=5');
      const btn = screen.getByTestId('invite-btn-invite');
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'access.actionDenied');
    });
  });

  it('mapa: o ponto recebe o tooltip do inventário e o centro o rótulo traduzido', () => {
    board.value = ready([cand('a', 1.25)], ['a']);
    renderPage('/admin/vacancies/v1/match?paso=5');
    expect(screen.getByTestId('pin-a')).toHaveAttribute('data-tooltip', 'admin.vacancyInvite.map.pin{"name":"a","distance":"1,3"}');
    expect(screen.getByTestId('points-map-stub')).toHaveAttribute('data-center-label', 'admin.vacancyInvite.map.center');
  });
});
