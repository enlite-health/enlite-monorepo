/**
 * PresenceReviewPage (emenda 077 §6, T-806-57): os 4 tipos de item, a decisão que EXIGE código de resolução, o read-back depois de decidir,
 * os filtros e o "Sin acceso" sem a célula. Texto REAL em es (não a chave): a tela mostra o que o texto do §3.5/§6 manda.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18next from 'i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { chooseCombo } from '@presentation/components/atoms/Combobox/testUtils';
import { PresenceReviewPage } from '../PresenceReviewPage';
import { presenceReviewErrorKey } from '../presenceReviewErrors';
import { ApiError } from '@infrastructure/http/ApiError';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { PresenceReviewItem, PresenceReviewPage as Page } from '@infrastructure/http/AdminPresenceReviewApiService';

const h = vi.hoisted(() => ({ t: (k: string): string => k }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (h.t as (k: string, o?: unknown) => string)(k, o), i18n: { language: 'es' } }) }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('t') })),
}));
const api = { getQueue: vi.fn(), decide: vi.fn() };
vi.mock('@infrastructure/http/AdminPresenceReviewApiService', async (orig) => ({
  ...(await orig<typeof import('@infrastructure/http/AdminPresenceReviewApiService')>()),
  AdminPresenceReviewApiService: { getQueue: (...a: unknown[]) => api.getQueue(...a), decide: (...a: unknown[]) => api.decide(...a) },
}));

beforeAll(async () => {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: 'es', resources: { es: { translation: esJson } }, interpolation: { escapeValue: false } });
  h.t = i18n.t.bind(i18n) as never;
});

const item = (over: Partial<PresenceReviewItem> = {}): PresenceReviewItem => ({
  kind: 'EXCEPTION_PENDING', id: 'ev-1', occurredAt: '2026-11-25T14:00:00.000Z', onDate: '2026-11-25', startTime: '08:00', endTime: '16:00',
  workerName: 'Fulana Prueba', caseNumber: 1234, reason: 'GPS_INDOOR', exceptionKind: 'GEO_DECLARED', distanceM: 180, accuracyM: 40, ...over,
});
const FOUR: PresenceReviewItem[] = [
  item(),
  item({ kind: 'EXIT_DECLARED', id: 'dec-1', workerName: 'Otra Prueba', caseNumber: 12, reason: null, exceptionKind: null, distanceM: null, accuracyM: null }),
  item({ kind: 'CLOCK_UNVERIFIED', id: 'ev-2', reason: null, exceptionKind: null }),
  item({ kind: 'ENTRY_REFUSED_NO_ENTRY', id: 'occ-1', onDate: null, startTime: null, endTime: null, caseNumber: null, reason: 'OUT_OF_WINDOW', exceptionKind: null, distanceM: null, accuracyM: null }),
];
const page = (items: PresenceReviewItem[], over: Partial<Page> = {}): Page => ({ country: 'AR', countries: ['AR'], items, nextCursor: null, ...over });

function postura(cells: string[] | 'loading' | 'error', enforcement: 'on' | 'off' = 'on'): void {
  if (cells === 'loading') { useAdminAuthStore.setState({ authz: null, authzStatus: 'loading' }); return; }
  if (cells === 'error') { useAdminAuthStore.setState({ authz: null, authzStatus: 'error' }); return; }
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: cells, countries: ['AR'], groups: [], features: {}, enforcement } as AuthzContract,
  });
}
const CELL = ['presence_exception:review'];

describe('PresenceReviewPage — gate por célula', () => {
  beforeEach(() => { api.getQueue.mockReset(); api.decide.mockReset(); });

  it('🔴 sem a célula (engine ligado): diz "Sin acceso", sem redirecionar e SEM chamar a API', () => {
    postura(['worker:read']);
    render(<PresenceReviewPage />);
    expect(screen.getByTestId('presence-no-access')).toHaveTextContent('Sin acceso');
    expect(api.getQueue).not.toHaveBeenCalled();
  });

  it('engine do front desligado mas a API responde 403: cai no mesmo "Sin acceso"', async () => {
    postura([], 'off');
    api.getQueue.mockRejectedValue(new ApiError({ success: false, error: 'Access denied', code: 'missing_cell' }, 403));
    render(<PresenceReviewPage />);
    expect(await screen.findByTestId('presence-no-access')).toHaveTextContent('Sin acceso');
  });

  it('contrato carregando diz que carrega; em erro diz que falhou — sem API nos dois', () => {
    postura('loading');
    const { unmount } = render(<PresenceReviewPage />);
    expect(screen.getByText('Cargando…')).toBeInTheDocument();
    unmount();
    postura('error');
    render(<PresenceReviewPage />);
    expect(screen.getByRole('alert')).toHaveTextContent('No se pudo verificar tu acceso');
    expect(api.getQueue).not.toHaveBeenCalled();
  });
});

describe('PresenceReviewPage — a fila', () => {
  beforeEach(() => { api.getQueue.mockReset(); api.decide.mockReset(); postura(CELL); });

  it('os 4 tipos aparecem com as colunas do §6; Aprobar/Rechazar SÓ na exceção de lugar e "a conferir" nos outros 3', async () => {
    api.getQueue.mockResolvedValue(page(FOUR));
    render(<PresenceReviewPage />);
    const rows = await screen.findAllByTestId('presence-row');
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['EXCEPTION_PENDING', 'EXIT_DECLARED', 'CLOCK_UNVERIFIED', 'ENTRY_REFUSED_NO_ENTRY']);
    for (const col of ['Tipo', 'Fecha y horario del turno', 'Prestador/a', 'Paciente (nº de caso)', 'Motivo elegido', 'Distancia y precisión', 'Acción']) {
      expect(screen.getByRole('columnheader', { name: col })).toBeInTheDocument();
    }
    const exc = within(rows[0]);
    expect(exc.getByText('Excepción de lugar')).toBeInTheDocument();
    expect(exc.getByText('25/11/2026 · 08:00–16:00')).toBeInTheDocument();
    expect(exc.getByText('Fulana Prueba')).toBeInTheDocument();
    expect(exc.getByText('Caso EN1234')).toBeInTheDocument();
    expect(exc.getByText('El GPS no funciona adentro de la casa')).toBeInTheDocument();
    expect(exc.getByText('180 m del paciente · precisión ±40 m')).toBeInTheDocument();
    expect(exc.getByRole('button', { name: 'Aprobar' })).toBeInTheDocument();
    expect(exc.getByRole('button', { name: 'Rechazar' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Aprobar' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Rechazar' })).toHaveLength(1);
    expect(screen.getAllByText('A conferir en la validación mensual')).toHaveLength(3);
    expect(within(rows[1]).getByText('Caso 12')).toBeInTheDocument();
    expect(within(rows[3]).getByText('Fuera del horario permitido')).toBeInTheDocument();
  });

  it('exceção detectada pelo servidor (sem motivo escolhido) e motivo desconhecido: texto humano, nunca o código cru', async () => {
    api.getQueue.mockResolvedValue(page([item({ reason: null, exceptionKind: 'GEO_SERVER_DISAGREES' }), item({ id: 'ev-9', reason: 'ALGO_NOVO' })]));
    render(<PresenceReviewPage />);
    expect(await screen.findByText('El servidor detectó otra ubicación; la prestadora no eligió motivo')).toBeInTheDocument();
    expect(screen.getByText('Otro motivo')).toBeInTheDocument();
    expect(screen.queryByText('ALGO_NOVO')).not.toBeInTheDocument();
  });

  it('fila vazia diz que não há nada; erro de carga diz que falhou', async () => {
    api.getQueue.mockResolvedValueOnce(page([]));
    const { unmount } = render(<PresenceReviewPage />);
    expect(await screen.findByTestId('presence-empty')).toHaveTextContent('No hay nada para revisar.');
    unmount();
    api.getQueue.mockRejectedValueOnce(new Error('boom'));
    render(<PresenceReviewPage />);
    expect(await screen.findByTestId('presence-error')).toHaveTextContent('No se pudo cargar la fila');
  });

  it('filtro por tipo: relê a fila com o kind; o filtro de país só existe com mais de um país e relê com ele', async () => {
    api.getQueue.mockResolvedValue(page(FOUR, { countries: ['AR', 'BR'] }));
    render(<PresenceReviewPage />);
    await screen.findAllByTestId('presence-row');
    chooseCombo(screen.getByTestId('presence-filter-kind'), 'Salida declarada');
    await waitFor(() => expect(api.getQueue).toHaveBeenLastCalledWith({ country: undefined, kind: 'EXIT_DECLARED' }));
    chooseCombo(screen.getByTestId('presence-filter-country'), 'BR');
    await waitFor(() => expect(api.getQueue).toHaveBeenLastCalledWith({ country: 'BR', kind: 'EXIT_DECLARED' }));
  });

  it('sem 2º país não há filtro de país; "Cargar más" pede a próxima página pelo cursor e acrescenta', async () => {
    api.getQueue.mockResolvedValueOnce(page([item()], { nextCursor: 'c1' })).mockResolvedValueOnce(page([item({ id: 'ev-2', workerName: 'Segunda Prueba' })]));
    render(<PresenceReviewPage />);
    await screen.findByText('Fulana Prueba');
    expect(screen.queryByTestId('presence-filter-country')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('presence-load-more'));
    expect(await screen.findByText('Segunda Prueba')).toBeInTheDocument();
    expect(api.getQueue).toHaveBeenLastCalledWith({ country: undefined, kind: undefined, cursor: 'c1' });
    expect(screen.getAllByTestId('presence-row')).toHaveLength(2);
    expect(screen.queryByTestId('presence-load-more')).not.toBeInTheDocument();
  });
});

describe('PresenceReviewPage — a decisão', () => {
  beforeEach(() => { api.getQueue.mockReset(); api.decide.mockReset(); postura(CELL); });

  it('🔴 a decisão EXIGE o código: sem escolher, o botão fica desabilitado e a API não é chamada; as 5 opções são os textos do §3.5', async () => {
    api.getQueue.mockResolvedValue(page(FOUR));
    const user = userEvent.setup();
    render(<PresenceReviewPage />);
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    const dialog = screen.getByTestId('presence-dialog');
    expect(screen.getByTestId('presence-dialog-confirm')).toBeDisabled();
    expect(within(dialog).getAllByRole('radio')).toHaveLength(5);
    for (const txt of ['GPS adentro, confirmado', 'Dirección a corregir', 'Paciente en otro lugar, confirmado', 'No estaba con el paciente', 'Sin forma de confirmar']) {
      expect(within(dialog).getByLabelText(txt)).not.toBeChecked();
    }
    expect(api.decide).not.toHaveBeenCalled();
  });

  it('feliz: aprobar com código grava e RELÊ a fila (read-back): o item sai porque o attendance deixou de devolvê-lo', async () => {
    api.getQueue.mockResolvedValueOnce(page(FOUR)).mockResolvedValueOnce(page(FOUR.slice(1)));
    api.decide.mockResolvedValue({ eventId: 'ev-1', decision: 'APPROVED', resolutionCode: 'INDOOR_CONFIRMED' });
    const user = userEvent.setup();
    render(<PresenceReviewPage />);
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    await user.click(screen.getByLabelText('GPS adentro, confirmado'));
    await user.click(screen.getByTestId('presence-dialog-confirm'));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('ev-1', 'APPROVED', 'INDOOR_CONFIRMED'));
    await waitFor(() => expect(api.getQueue).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByTestId('presence-row')).toHaveLength(3));
    expect(screen.queryByTestId('presence-dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Excepción de lugar')).not.toBeInTheDocument();
  });

  it('alternativo: rechazar com OUTRO código manda REFUSED e esse código', async () => {
    api.getQueue.mockResolvedValue(page([item()]));
    api.decide.mockResolvedValue({ eventId: 'ev-1', decision: 'REFUSED', resolutionCode: 'NOT_AT_PATIENT' });
    const user = userEvent.setup();
    render(<PresenceReviewPage />);
    await user.click(await screen.findByRole('button', { name: 'Rechazar' }));
    expect(screen.getByRole('heading', { name: 'Rechazar excepción de lugar' })).toBeInTheDocument();
    await user.click(screen.getByLabelText('No estaba con el paciente'));
    await user.click(screen.getByTestId('presence-dialog-confirm'));
    await waitFor(() => expect(api.decide).toHaveBeenCalledWith('ev-1', 'REFUSED', 'NOT_AT_PATIENT'));
  });

  it('2ª decisão (409): diz que já foi decidida e relê a fila; cancelar fecha sem gravar', async () => {
    api.getQueue.mockResolvedValue(page([item()]));
    api.decide.mockRejectedValue(new ApiError({ success: false, error: 'x', code: 'EXCEPTION_ALREADY_DECIDED' }, 409));
    const user = userEvent.setup();
    render(<PresenceReviewPage />);
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    await user.click(screen.getByLabelText('Sin forma de confirmar'));
    await user.click(screen.getByTestId('presence-dialog-confirm'));
    expect(await screen.findByTestId('presence-dialog-error')).toHaveTextContent('Esta excepción ya tiene una decisión');
    await waitFor(() => expect(api.getQueue).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByTestId('presence-dialog')).not.toBeInTheDocument();
  });

  it('403 na decisão (perdeu a célula): cai em "Sin acceso"', async () => {
    api.getQueue.mockResolvedValue(page([item()]));
    api.decide.mockRejectedValue(new ApiError({ success: false, error: 'Access denied' }, 403));
    const user = userEvent.setup();
    render(<PresenceReviewPage />);
    await user.click(await screen.findByRole('button', { name: 'Aprobar' }));
    await user.click(screen.getByLabelText('GPS adentro, confirmado'));
    await user.click(screen.getByTestId('presence-dialog-confirm'));
    expect(await screen.findByTestId('presence-no-access')).toBeInTheDocument();
  });
});

describe('presenceReviewErrorKey', () => {
  it('discrimina pelo code/status estável do backend', () => {
    const e = (status: number, code?: string) => new ApiError({ success: false, error: 'x', code }, status);
    expect(presenceReviewErrorKey(e(409))).toBe('admin.presenceReview.errors.alreadyDecided');
    expect(presenceReviewErrorKey(e(404, 'EXCEPTION_NOT_FOUND'))).toBe('admin.presenceReview.errors.notFound');
    expect(presenceReviewErrorKey(e(503, 'UPSTREAM_UNAVAILABLE'))).toBe('admin.presenceReview.errors.unavailable');
    expect(presenceReviewErrorKey(e(400))).toBe('admin.presenceReview.errors.generic');
    expect(presenceReviewErrorKey(new Error('x'))).toBe('admin.presenceReview.errors.generic');
  });
});
