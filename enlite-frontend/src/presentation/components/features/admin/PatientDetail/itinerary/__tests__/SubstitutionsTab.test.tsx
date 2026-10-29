/**
 * SubstitutionsTab (+ Row, DaysList, SaleEntraBlock) — spec 069, US6/FR-20 (mockup `b2c.png`): Cuándo · Sale ↓ · Entra ↑ · Acción, no
 * formato de substituição de futebol. O sentido não depende de cor (ícone + rótulo + aria-label); "sem cobertura" mora NO CAMPO Entra.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { SubstitutionRequestItem } from '@domain/entities/SubstitutionRequest';
import { initI18n, i18n } from './i18nSetup';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';
import { SubstitutionsTab } from '../SubstitutionsTab';

vi.mock('@infrastructure/http/AdminSubstitutionRequestsApiService', () => ({ AdminSubstitutionRequestsApiService: { list: vi.fn(), undo: vi.fn() } }));
vi.mock('@hooks/admin/useServiceExitReasonOptions', () => ({
  useServiceExitReasonOptions: () => ({ options: [{ code: 'SICK', label: 'Enfermedad' }, { code: 'VACATION', label: 'Vacaciones' }], status: 'ok' }),
}));
const list = AdminSubstitutionRequestsApiService.list as ReturnType<typeof vi.fn>;
const undo = AdminSubstitutionRequestsApiService.undo as ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await initI18n('es');
});

function req(over: Partial<SubstitutionRequestItem>): SubstitutionRequestItem {
  return {
    requestId: 'rq-1', legacy: false, type: 'ONE_DAY', from: '2026-11-03', to: '2026-11-03', shiftCount: 1, outgoingWorkerId: 'w-lucia', reasonCode: 'SICK',
    entra: { kind: 'NOBODY', workerIds: [], uncoveredDates: ['2026-11-03'] },
    shifts: [{ date: '2026-11-03', startTime: '22:00:00', endTime: '06:00:00', assignmentId: 'a-1', workerId: null }],
    createdAt: null, createdBy: null, undoneAt: null, undoneBy: null, undoable: true, adjusted: false, when: 'upcoming',
    outgoingDisplayName: 'Lucía Fernández', entraDisplayNames: [], shiftDisplayNames: [null], ...over,
  };
}
const NOBODY = req({});
const ONE_PERSON = req({
  requestId: 'rq-2', from: '2026-11-08', to: '2026-11-08', reasonCode: 'CODIGO_FORA_DO_CATALOGO',
  entra: { kind: 'PERSON', workerIds: ['w-martin'], uncoveredDates: [] }, entraDisplayNames: ['Martín Gómez'],
  shifts: [{ date: '2026-11-08', startTime: '09:00', endTime: '17:00', assignmentId: 'a-2', workerId: 'w-martin' }], shiftDisplayNames: ['Martín Gómez'],
});
const PARTIAL = req({
  requestId: 'rq-3', type: 'DAYS', from: '2026-11-09', to: '2026-11-20', shiftCount: 3, reasonCode: 'VACATION',
  entra: { kind: 'PARTIAL', workerIds: ['w-martin'], uncoveredDates: ['2026-11-09'] }, entraDisplayNames: ['Martín Gómez'],
  shifts: [
    { date: '2026-11-09', startTime: '09:00', endTime: '17:00', assignmentId: 'a-3', workerId: null },
    { date: '2026-11-15', startTime: '09:00', endTime: '17:00', assignmentId: 'a-3', workerId: 'w-martin' },
    { date: '2026-11-16', startTime: null, endTime: null, assignmentId: null, workerId: 'w-sem-nome' },
  ],
  shiftDisplayNames: [null, 'Martín Gómez', null],
});
const PERMANENT = req({
  requestId: 'rq-4', type: 'PERMANENT', from: '2026-12-01', to: null, shiftCount: 2, outgoingWorkerId: 'w-ana', outgoingDisplayName: 'Ana Ruiz', reasonCode: null,
  entra: { kind: 'NOBODY', workerIds: [], uncoveredDates: [] },
  shifts: [{ date: '2026-12-01', startTime: '09:00', endTime: '17:00', assignmentId: 'a-4', workerId: null }, { date: '2026-12-01', startTime: '14:00', endTime: '18:00', assignmentId: 'a-5', workerId: null }],
  shiftDisplayNames: [null, null],
});
const CROSS_MONTH = req({ requestId: 'rq-5', type: 'DAYS', from: '2026-10-28', to: '2026-11-03', shiftCount: 2, shifts: [], shiftDisplayNames: [] });

beforeEach(() => {
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  list.mockReset().mockResolvedValue({ patientId: 'p-1', serviceId: 's-1', when: 'upcoming', requests: [NOBODY, ONE_PERSON, PARTIAL, PERMANENT] });
  undo.mockReset().mockResolvedValue({ requestId: 'rq-1' });
});

function renderTab(over: Partial<React.ComponentProps<typeof SubstitutionsTab>> = {}) {
  const props = { patientId: 'p-1', serviceId: 's-1', refreshKey: 0, onNew: vi.fn(), onPick: vi.fn(), onChanged: vi.fn(), ...over };
  return { ...render(<SubstitutionsTab {...props} />), props };
}

describe('SubstitutionsTab — a lista', () => {
  it('cabeçalho Cuándo · Cambio · Acción; UMA linha por pedido; filtro Próximas ativo', async () => {
    const { container } = renderTab();
    expect(await screen.findByTestId('sustituciones-lista')).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith('p-1', 's-1', 'upcoming');
    const list_ = screen.getByTestId('sustituciones-lista');
    for (const header of ['Cuándo', 'Cambio', 'Acción']) expect(within(list_).getByText(header)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^sustitucion-rq-/)).toHaveLength(4);
    expect(screen.getByTestId('sustituciones-filtro-upcoming')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('sustituciones-filtro-past')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('group', { name: 'Sustituciones' })).toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  it('Cuándo: dia por extenso + "Un día · 1 turno"; período + "Varios días · 3 turnos"; "Desde el 1 de diciembre" + "No vuelve más" (sem contagem)', async () => {
    renderTab();
    await screen.findByTestId('sustituciones-lista');
    expect(screen.getByTestId('sustitucion-rq-1')).toHaveTextContent('Martes 3 de noviembre');
    expect(screen.getByTestId('sustitucion-rq-1')).toHaveTextContent('Un día · 1 turno');
    expect(screen.getByTestId('sustitucion-rq-3')).toHaveTextContent('9 al 20 de noviembre');
    expect(screen.getByTestId('sustitucion-rq-3')).toHaveTextContent('Varios días · 3 turnos');
    expect(screen.getByTestId('sustitucion-rq-4')).toHaveTextContent('Desde el 1 de diciembre');
    expect(screen.getByTestId('sustitucion-rq-4')).toHaveTextContent('No vuelve más');
    expect(screen.getByTestId('sustitucion-rq-4')).not.toHaveTextContent(/\d turnos/);
  });

  it('Sale: seta ↓ por ÍCONE com aria-label "Sale", quem sai e o MOTIVO do catálogo; motivo fora do catálogo/ausente não vaza código cru', async () => {
    const { container } = renderTab();
    await screen.findByTestId('sustituciones-lista');
    const sale = screen.getByTestId('sustitucion-bloque-rq-1-sale');
    expect(within(sale).getByRole('img', { name: 'Sale' })).toBeInTheDocument();
    expect(sale).toHaveTextContent('Lucía Fernández');
    expect(sale).toHaveTextContent('Enfermedad');
    expect(screen.getByTestId('sustitucion-bloque-rq-3-sale')).toHaveTextContent('Vacaciones');
    expect(screen.getByTestId('sustitucion-bloque-rq-2-sale')).not.toHaveTextContent('CODIGO_FORA_DO_CATALOGO');
    expect(screen.getByTestId('sustitucion-bloque-rq-4-sale')).toHaveTextContent(/^ARAna Ruiz$/);
    expect(container).not.toHaveTextContent('CODIGO_FORA_DO_CATALOGO');
  });

  it('Entra: seta ↑ com aria-label "Entra"; pessoa; "salvo lun 9: nadie"; sem substituto = "Nadie todavía" + "Elegir quién entra" NO CAMPO (não num selo à parte)', async () => {
    renderTab();
    await screen.findByTestId('sustituciones-lista');
    const entra1 = screen.getByTestId('sustitucion-bloque-rq-1-entra');
    expect(within(entra1).getByRole('img', { name: 'Entra' })).toBeInTheDocument();
    expect(entra1).toHaveTextContent('Nadie todavía');
    expect(within(entra1).getByRole('button', { name: 'Elegir quién entra' })).toBeInTheDocument();
    expect(screen.getByTestId('sustitucion-bloque-rq-2-entra')).toHaveTextContent('Martín Gómez');
    expect(screen.getByTestId('sustitucion-bloque-rq-2-entra')).not.toHaveTextContent('Nadie todavía');
    expect(screen.queryByTestId('sustitucion-bloque-rq-2-elegir')).toBeNull();
    expect(screen.getByTestId('sustitucion-bloque-rq-3-salvo')).toHaveTextContent('salvo lun 9: nadie');
    expect(screen.getByTestId('sustitucion-bloque-rq-3-entra')).toHaveTextContent('Martín Gómez');
    // "No vuelve más" sem substituto: "Nadie todavía" + "Elegir quién entra" também
    expect(screen.getByTestId('sustitucion-bloque-rq-4-entra')).toHaveTextContent('Nadie todavía');
    // nenhum selo "Sin cubrir" fora do campo Entra
    expect(screen.getByTestId('sustitucion-rq-1')).not.toHaveTextContent('Sin cubrir');
  });

  it('"Elegir quién entra" sobe o pedido; "Ver días" SÓ com mais de um turno; mostra um item por turno com quem entra (ou "Nadie todavía"); "Ocultar días" fecha', async () => {
    const { props } = renderTab();
    await screen.findByTestId('sustituciones-lista');
    fireEvent.click(screen.getByTestId('sustitucion-bloque-rq-1-elegir'));
    expect(props.onPick).toHaveBeenCalledWith(NOBODY);
    expect(screen.queryByTestId('sustitucion-ver-dias-rq-1')).toBeNull(); // 1 turno
    expect(screen.queryByTestId('sustitucion-ver-dias-rq-2')).toBeNull();
    const toggle = screen.getByTestId('sustitucion-ver-dias-rq-3');
    expect(toggle).toHaveTextContent('Ver días');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const days = screen.getByTestId('sustituciones-dias-rq-3');
    const items = within(days).getAllByTestId('sustituciones-dia');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Lunes 9 de noviembre');
    expect(items[0]).toHaveTextContent('09:00 – 17:00');
    expect(items[0]).toHaveTextContent('Nadie todavía');
    expect(items[1]).toHaveTextContent('Martín Gómez');
    expect(items[2]).toHaveTextContent('Prestador sin nombre');
    expect(items[2]).not.toHaveTextContent('–'); // sem horário conhecido, nada de "–" solto
    expect(screen.getByTestId('sustitucion-ver-dias-rq-3')).toHaveTextContent('Ocultar días');
    fireEvent.click(screen.getByTestId('sustitucion-ver-dias-rq-3'));
    expect(screen.queryByTestId('sustituciones-dias-rq-3')).toBeNull();
  });

  it('ausência de ANTES dos pedidos (sem id) com 2 turnos: "Ver días" abre a lista (testid de legado); quem entra sem nome na lista vira "Prestador sin nombre"', async () => {
    const legacy = req({
      requestId: null, legacy: true, type: 'DAYS', from: '2026-11-09', to: '2026-11-10', shiftCount: 2, undoable: false,
      entra: { kind: 'PERSON', workerIds: ['w-sem-nome'], uncoveredDates: [] }, entraDisplayNames: [],
      shifts: [{ date: '2026-11-09', startTime: '09:00', endTime: '17:00', assignmentId: 'a', workerId: 'w-sem-nome' }, { date: '2026-11-10', startTime: '09:00', endTime: '17:00', assignmentId: 'a', workerId: 'w-sem-nome' }],
      shiftDisplayNames: [],
    });
    list.mockResolvedValue({ patientId: 'p-1', serviceId: 's-1', when: 'upcoming', requests: [legacy] });
    renderTab();
    await screen.findByTestId('sustituciones-lista');
    expect(screen.getByTestId('sustitucion-bloque-legacy-entra')).toHaveTextContent('Prestador sin nombre');
    fireEvent.click(screen.getByTestId('sustitucion-ver-dias-legacy'));
    expect(within(screen.getByTestId('sustituciones-dias-legacy')).getAllByTestId('sustituciones-dia')).toHaveLength(2);
    expect(screen.getByTestId('sustituciones-dias-legacy')).toHaveTextContent('Prestador sin nombre');
  });

  it('"Ver días" de um pedido com shiftCount > 1 mas sem lista de turnos não quebra (lista vazia)', async () => {
    list.mockResolvedValue({ patientId: 'p-1', serviceId: 's-1', when: 'upcoming', requests: [CROSS_MONTH] });
    renderTab();
    await screen.findByTestId('sustituciones-lista');
    expect(screen.getByTestId('sustitucion-rq-5')).toHaveTextContent('28 de octubre al 3 de noviembre');
    fireEvent.click(screen.getByTestId('sustitucion-ver-dias-rq-5'));
    expect(screen.queryAllByTestId('sustituciones-dia')).toHaveLength(0);
  });
});

describe('SubstitutionsTab — Deshacer, Pasadas, desfeitas', () => {
  it('"Deshacer" desfaz o pedido INTEIRO (rota :rid/undo) e avisa a tela para refazer as leituras', async () => {
    const { props } = renderTab();
    await screen.findByTestId('sustituciones-lista');
    expect(screen.getAllByRole('button', { name: 'Deshacer' })).toHaveLength(4);
    fireEvent.click(screen.getByTestId('sustitucion-deshacer-rq-1'));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(undo).toHaveBeenCalledWith('p-1', 's-1', 'rq-1');
    expect(screen.queryByTestId('sustituciones-deshacer-error')).toBeNull();
  });

  it('"Deshacer" recusado (409 REQUEST_NOT_UNDOABLE): mensagem por CÓDIGO e a tela refaz mesmo assim (volta ao estado do banco); erro sem código → mensagem genérica', async () => {
    undo.mockRejectedValueOnce(new ContractedServiceApiError('x', 409, { code: 'REQUEST_NOT_UNDOABLE' }));
    const { props, container } = renderTab();
    await screen.findByTestId('sustituciones-lista');
    fireEvent.click(screen.getByTestId('sustitucion-deshacer-rq-1'));
    expect(await screen.findByTestId('sustituciones-deshacer-error')).toHaveTextContent('Este pedido ya no tiene nada futuro que deshacer.');
    expect(container).not.toHaveTextContent('REQUEST_NOT_UNDOABLE');
    expect(props.onChanged).toHaveBeenCalledTimes(1);
    undo.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByTestId('sustitucion-deshacer-rq-1'));
    await waitFor(() => expect(screen.getByTestId('sustituciones-deshacer-error')).toHaveTextContent('No se pudo deshacer la sustitución.'));
    undo.mockRejectedValueOnce(new ContractedServiceApiError('x', 409, { code: 'SEM_TRADUCAO' }));
    fireEvent.click(screen.getByTestId('sustitucion-deshacer-rq-1'));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId('sustituciones-deshacer-error')).toHaveTextContent('No se pudo deshacer la sustitución.');
  });

  it('enquanto desfaz, o botão do pedido fica desabilitado (sem duplo clique)', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    undo.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { props } = renderTab();
    await screen.findByTestId('sustituciones-lista');
    fireEvent.click(screen.getByTestId('sustitucion-deshacer-rq-1'));
    expect(screen.getByTestId('sustitucion-deshacer-rq-1')).toBeDisabled();
    expect(screen.getByTestId('sustitucion-deshacer-rq-2')).toBeEnabled();
    resolve({});
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(screen.getByTestId('sustitucion-deshacer-rq-1')).toBeEnabled();
  });

  it('Pasadas: refaz o GET com `past`; pedido passado fica esmaecido e SEM "Deshacer" nem "Elegir quién entra"', async () => {
    renderTab();
    await screen.findByTestId('sustituciones-lista');
    list.mockResolvedValue({ patientId: 'p-1', serviceId: 's-1', when: 'past', requests: [req({ requestId: 'rq-9', when: 'past', undoable: false })] });
    fireEvent.click(screen.getByTestId('sustituciones-filtro-past'));
    await screen.findByTestId('sustitucion-rq-9');
    expect(list).toHaveBeenLastCalledWith('p-1', 's-1', 'past');
    expect(screen.getByTestId('sustituciones-filtro-past')).toHaveAttribute('aria-pressed', 'true');
    const row = screen.getByTestId('sustitucion-rq-9');
    expect(row).toHaveAttribute('data-when', 'past');
    expect(within(row).queryByRole('button', { name: 'Deshacer' })).toBeNull();
    expect(screen.queryByTestId('sustitucion-bloque-rq-9-elegir')).toBeNull();
    expect(screen.getByTestId('sustitucion-bloque-rq-9').className).toContain('opacity-70');
  });

  it('pedido DESFEITO: "Deshecha" com a data, sem ações; "Ajustado" quando o pedido foi ajustado; ausência de ANTES: "Sin pedido (anterior)" sem Deshacer/Elegir', async () => {
    list.mockResolvedValue({
      patientId: 'p-1', serviceId: 's-1', when: 'upcoming',
      requests: [
        req({ requestId: 'rq-6', undoneAt: '2026-10-22T15:00:00Z', undoable: false }),
        req({ requestId: 'rq-7', adjusted: true }),
        req({ requestId: null, legacy: true, undoable: true }),
      ],
    });
    renderTab();
    await screen.findByTestId('sustituciones-lista');
    expect(screen.getByTestId('sustitucion-deshecha-rq-6')).toHaveTextContent('Deshecha · 22/10');
    expect(screen.getByTestId('sustitucion-rq-6')).toHaveAttribute('data-undone', 'true');
    expect(within(screen.getByTestId('sustitucion-rq-6')).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('sustitucion-ajustado-rq-7')).toHaveTextContent('Ajustado');
    expect(screen.getByTestId('sustitucion-anterior-legacy')).toHaveTextContent('Sin pedido (anterior)');
    expect(within(screen.getByTestId('sustitucion-legacy')).queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('sustitucion-deshecha-rq-7')).toBeNull();
  });

  it('desfeita sem data (undoneAt inválido) não quebra: só "Deshecha"', async () => {
    list.mockResolvedValue({ patientId: 'p-1', serviceId: 's-1', when: 'upcoming', requests: [req({ requestId: 'rq-6', undoneAt: 'sem-data', undoable: false })] });
    renderTab();
    await screen.findByTestId('sustituciones-lista');
    expect(screen.getByTestId('sustitucion-deshecha-rq-6').textContent).toMatch(/^Deshecha/);
  });

  it('sem a célula patient_itinerary:update: "Deshacer" e "Elegir quién entra" somem (a lista segue legível)', async () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['patient_services:read'], countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
    });
    renderTab();
    await screen.findByTestId('sustituciones-lista');
    expect(screen.queryByRole('button', { name: 'Deshacer' })).toBeNull();
    expect(screen.queryByTestId('sustitucion-bloque-rq-1-elegir')).toBeNull();
    expect(screen.getByTestId('sustitucion-bloque-rq-1-entra')).toHaveTextContent('Nadie todavía');
  });
});

describe('SubstitutionsTab — estados', () => {
  it('sem pedido: estado vazio com "Nueva sustitución" (Próximas); em Pasadas só o texto', async () => {
    list.mockResolvedValue({ patientId: 'p-1', serviceId: 's-1', when: 'upcoming', requests: [] });
    const { props } = renderTab();
    expect(await screen.findByTestId('sustituciones-vacio')).toHaveTextContent('Todavía no hay sustituciones próximas en este servicio.');
    fireEvent.click(screen.getByTestId('sustituciones-vacio-nueva'));
    expect(props.onNew).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('sustituciones-filtro-past'));
    await waitFor(() => expect(screen.getByTestId('sustituciones-vacio')).toHaveTextContent('No hay sustituciones pasadas en este servicio.'));
    expect(screen.queryByTestId('sustituciones-vacio-nueva')).toBeNull();
  });

  it('carregando, erro e 403: mensagens de produto', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    list.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const a = renderTab();
    expect(screen.getByTestId('sustituciones-cargando')).toHaveTextContent('Cargando las sustituciones…');
    resolve({ patientId: 'p-1', serviceId: 's-1', when: 'upcoming', requests: [] });
    await screen.findByTestId('sustituciones-vacio');
    a.unmount();
    list.mockRejectedValueOnce(new Error('boom'));
    const b = renderTab();
    expect(await screen.findByTestId('sustituciones-error')).toHaveTextContent('No se pudieron cargar las sustituciones.');
    b.unmount();
    list.mockRejectedValueOnce(new ContractedServiceApiError('x', 403));
    renderTab();
    expect(await screen.findByTestId('sustituciones-error')).toHaveTextContent('No tenés permiso para ver las sustituciones de este servicio.');
  });

  it('pt-BR: cabeçalho, "Sai"/"Entra", "Desfazer" e o papel de quem entra', async () => {
    await act(async () => {
      await i18n.changeLanguage('pt-BR');
    });
    renderTab();
    await screen.findByTestId('sustituciones-lista');
    expect(within(screen.getByTestId('sustituciones-lista')).getByText('Quando')).toBeInTheDocument();
    expect(screen.getByTestId('sustitucion-rq-1')).toHaveTextContent('Ninguém ainda');
    expect(within(screen.getByTestId('sustitucion-bloque-rq-1-sale')).getByRole('img', { name: 'Sai' })).toBeInTheDocument();
    expect(screen.getByTestId('sustitucion-deshacer-rq-1')).toHaveTextContent('Desfazer');
    expect(screen.getByTestId('sustitucion-rq-3')).toHaveTextContent('exceto seg 9: ninguém');
    await act(async () => {
      await i18n.changeLanguage('es');
    });
  });
});
