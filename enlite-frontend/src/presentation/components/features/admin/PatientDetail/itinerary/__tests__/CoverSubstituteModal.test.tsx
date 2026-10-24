/**
 * CoverSubstituteModal — spec 069, T608/FR-20 "Elegir quién entra": a pré-visão de conflito IGNORA a própria falta do pedido
 * (`ignoreRequestId`, T6xx-extra) e "Asignar" só habilita com a pessoa LIVRE em todos os turnos que ela vai cobrir.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import type { SubstitutionRequestItem } from '@domain/entities/SubstitutionRequest';
import { initI18n } from './i18nSetup';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';
import { CoverSubstituteModal, type CoverTarget } from '../CoverSubstituteModal';

vi.mock('@infrastructure/http/AdminSubstitutionRequestsApiService', () => ({ AdminSubstitutionRequestsApiService: { preview: vi.fn(), cover: vi.fn() } }));
vi.mock('@infrastructure/http/AdminContractedServicesApiService', async () => {
  const actual = await vi.importActual<typeof import('@infrastructure/http/AdminContractedServicesApiService')>('@infrastructure/http/AdminContractedServicesApiService');
  return { ...actual, AdminContractedServicesApiService: { getAllocationOptions: vi.fn(), setAbsenceSubstitute: vi.fn() } };
});

const preview = AdminSubstitutionRequestsApiService.preview as ReturnType<typeof vi.fn>;
const cover = AdminSubstitutionRequestsApiService.cover as ReturnType<typeof vi.fn>;
const allocationOptions = AdminContractedServicesApiService.getAllocationOptions as ReturnType<typeof vi.fn>;
const setAbsenceSubstitute = AdminContractedServicesApiService.setAbsenceSubstitute as ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await initI18n('es');
});

const AS_OF = '2026-10-21';
type Body = { type: string; from: string; to?: string; candidateWorkerIds: string[]; ignoreRequestId?: string };
let states: Record<string, 'conflict' | 'unknown' | 'free'>;
let previewShifts: Array<{ date: string; slotId: string; assignmentId: string; startTime: string; endTime: string }>;

const shift = (date: string, assignmentId: string, slotId = `sl-${assignmentId}`) => ({ date, slotId, assignmentId, startTime: '09:00', endTime: '17:00' });

function previewImpl(body: Body) {
  const conflicts = body.candidateWorkerIds.flatMap((workerId) =>
    previewShifts.map((s) => {
      const state = states[`${workerId}|${s.date}`] ?? 'free';
      return { workerId, date: s.date, slotId: s.slotId, state, overlaps: state === 'conflict' ? [{ weekday: 1, startTime: '10:00', durationMinutes: 240, sameAddress: false }] : [] };
    }),
  );
  return Promise.resolve({ shifts: previewShifts, conflicts, statusAfter: null });
}

beforeEach(() => {
  states = {};
  previewShifts = [shift('2026-11-02', 'a-1'), shift('2026-11-04', 'a-2'), shift('2026-11-06', 'a-3')];
  preview.mockReset().mockImplementation((_p: string, _s: string, body: Body) => previewImpl(body));
  cover.mockReset().mockResolvedValue({ requestId: 'rq-1', type: 'DAYS', covered: 2 });
  setAbsenceSubstitute.mockReset().mockResolvedValue({});
  allocationOptions.mockReset().mockResolvedValue({
    vacancyId: 'v',
    options: [
      { workerId: 'w-out', displayName: 'Lucía Fernández', vacancyId: 'v', status: 'IN_SERVICE' },
      { workerId: 'w-martin', displayName: 'Martín Gómez', vacancyId: 'v', status: 'QUICK_RESPONSE' },
      { workerId: 'w-bia', displayName: 'Bia Costa', vacancyId: 'v', status: 'SELECTED' },
    ],
  });
});

function request(over: Partial<SubstitutionRequestItem> = {}): SubstitutionRequestItem {
  return {
    requestId: 'rq-1', legacy: false, type: 'DAYS', from: '2026-11-02', to: '2026-11-06', shiftCount: 3, outgoingWorkerId: 'w-out', reasonCode: 'OTHER',
    entra: { kind: 'PARTIAL', workerIds: ['w-bia'], uncoveredDates: ['2026-11-02', '2026-11-06'] },
    shifts: [
      { date: '2026-11-02', startTime: '09:00', endTime: '17:00', assignmentId: 'a-1', workerId: null },
      { date: '2026-11-04', startTime: '09:00', endTime: '17:00', assignmentId: 'a-2', workerId: 'w-bia' },
      { date: '2026-11-06', startTime: '09:00', endTime: '17:00', assignmentId: 'a-3', workerId: null },
    ],
    createdAt: null, createdBy: null, undoneAt: null, undoneBy: null, undoable: true, adjusted: false, when: 'upcoming', outgoingDisplayName: 'Lucía Fernández', entraDisplayNames: ['Bia Costa'], shiftDisplayNames: [null, 'Bia Costa', null],
    ...over,
  };
}

const EVENT: PatientItineraryEvent = {
  date: '2026-11-04', weekday: 3, serviceId: 's-1', slotId: 'sl-a-2', assignmentId: 'a-2', startTime: '09:00', endTime: '17:00', titularWorkerId: 'w-out', titularDisplayName: 'Lucía Fernández',
  status: 'uncovered', workerId: null, workerDisplayName: null, substituteWorkerId: null, substituteDisplayName: null, absenceId: 'ab-2', requestId: 'rq-1',
};

function renderModal(target: CoverTarget, over: Partial<React.ComponentProps<typeof CoverSubstituteModal>> = {}) {
  const props = { patientId: 'p-1', serviceId: 's-1', asOf: AS_OF, target, onClose: vi.fn(), onDone: vi.fn(), ...over };
  return { ...render(<CoverSubstituteModal {...props} />), props };
}

async function pick(workerId: string) {
  await screen.findByRole('option', { name: 'Martín Gómez' });
  fireEvent.change(screen.getByTestId('sustitucion-cubrir-persona'), { target: { value: workerId } });
}

describe('CoverSubstituteModal — pedido (aba "Sustituciones")', () => {
  it('Varios días: pergunta SÓ os turnos sem ninguém (de hoje em diante) e passa o `ignoreRequestId`; o pool não traz o titular; confirmar chama `cover`', async () => {
    const { container, props } = renderModal({ kind: 'request', request: request() });
    expect(screen.getByRole('heading', { name: '¿Quién entra?' })).toBeInTheDocument();
    expect(screen.queryByTestId('substitucion-paso')).toBeNull(); // janela de UM passo: sem "Paso N de 4"
    await screen.findByRole('option', { name: 'Martín Gómez' });
    expect(within(screen.getByTestId('sustitucion-cubrir-persona')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Elegir persona', 'Martín Gómez', 'Bia Costa']);
    expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeDisabled();
    expect(preview).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('sustitucion-cubrir-persona'), { target: { value: 'w-martin' } });
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', { type: 'DAYS', outgoingWorkerId: 'w-out', from: '2026-11-02', to: '2026-11-06', ignoreRequestId: 'rq-1', candidateWorkerIds: ['w-martin'] });
    await waitFor(() => expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeEnabled());
    // o turno do meio (4/11) já tem quem entra: não conta para ESTE cover
    expect(screen.getAllByTestId(/^sustitucion-cubrir-turno-/).map((t) => t.getAttribute('data-testid'))).toEqual([
      'sustitucion-cubrir-turno-2026-11-02|sl-a-1',
      'sustitucion-cubrir-turno-2026-11-06|sl-a-3',
    ]);
    expect(screen.getByTestId('sustitucion-cubrir-elegida')).toHaveTextContent('Martín Gómez');
    fireEvent.click(screen.getByTestId('sustitucion-cubrir-confirmar'));
    await waitFor(() => expect(props.onDone).toHaveBeenCalledTimes(1));
    expect(cover).toHaveBeenCalledWith('p-1', 's-1', 'rq-1', 'w-martin');
    expectNoRawEnumLeaks(container);
  });

  it('turno sem ninguém ANTES de hoje não entra no período perguntado (o que passou não se cobre)', async () => {
    const r = request({ shifts: [{ date: '2026-10-15', startTime: '09:00', endTime: '17:00', assignmentId: 'a-0', workerId: null }, ...request().shifts] });
    renderModal({ kind: 'request', request: r });
    await pick('w-martin');
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', expect.objectContaining({ from: '2026-11-02', to: '2026-11-06' }));
  });

  it('Un día: corpo ONE_DAY sem `to`', async () => {
    previewShifts = [shift('2026-11-02', 'a-1')];
    renderModal({ kind: 'request', request: request({ type: 'ONE_DAY', shifts: [request().shifts[0]], shiftCount: 1 }) });
    await pick('w-martin');
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', { type: 'ONE_DAY', outgoingWorkerId: 'w-out', from: '2026-11-02', ignoreRequestId: 'rq-1', candidateWorkerIds: ['w-martin'] });
  });

  it('No vuelve más: pré-visão PERMANENT a partir de max(D, hoje); todas as franjas contam', async () => {
    previewShifts = [shift('2026-12-01', 'a-1'), shift('2026-12-01', 'a-2')];
    const a = renderModal({ kind: 'request', request: request({ type: 'PERMANENT', from: '2026-12-01', to: null }) });
    await pick('w-martin');
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', { type: 'PERMANENT', outgoingWorkerId: 'w-out', from: '2026-12-01', candidateWorkerIds: ['w-martin'] });
    await waitFor(() => expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeEnabled());
    expect(screen.getAllByTestId(/^sustitucion-cubrir-turno-/)).toHaveLength(2);
    a.unmount();
    renderModal({ kind: 'request', request: request({ type: 'PERMANENT', from: '2026-10-01', to: null }) });
    await pick('w-martin');
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', expect.objectContaining({ type: 'PERMANENT', from: AS_OF }));
  });

  it('pedido sem nada a cobrir: NOTHING_TO_COVER traduzido, nenhuma pré-visão, "Asignar" desabilitado', () => {
    renderModal({ kind: 'request', request: request({ shifts: request().shifts.map((s) => ({ ...s, workerId: 'w-bia' })) }) });
    expect(screen.getByTestId('sustitucion-cubrir-nada')).toHaveTextContent('No queda ningún turno sin cubrir en este pedido.');
    expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeDisabled();
    expect(preview).not.toHaveBeenCalled();
  });

  it('CONFLITO: nota com o horário, "Conflicto", "Asignar" bloqueado; outra pessoa livre desbloqueia', async () => {
    states = { 'w-martin|2026-11-06': 'conflict' };
    renderModal({ kind: 'request', request: request() });
    await pick('w-martin');
    expect(await screen.findByTestId('sustitucion-cubrir-conflicto-2026-11-06|sl-a-3')).toHaveTextContent('Martín ya atiende a otro paciente el lunes de 10:00 a 14:00.');
    expect(screen.getByTestId('sustitucion-cubrir-estado-2026-11-06|sl-a-3')).toHaveTextContent('Conflicto');
    expect(screen.getByTestId('sustitucion-cubrir-estado-2026-11-02|sl-a-1')).toHaveTextContent('Libre');
    expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeDisabled();
    fireEvent.change(screen.getByTestId('sustitucion-cubrir-persona'), { target: { value: 'w-bia' } });
    await waitFor(() => expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeEnabled());
  });

  it('verificação que falhou (`unknown` ou a chamada toda) nunca vale como livre; enquanto espera: "Verificando…"', async () => {
    states = { 'w-martin|2026-11-02': 'unknown' };
    const a = renderModal({ kind: 'request', request: request() });
    await pick('w-martin');
    expect(await screen.findByTestId('sustitucion-cubrir-estado-2026-11-02|sl-a-1')).toHaveTextContent('No se pudo verificar');
    expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeDisabled();
    a.unmount();

    preview.mockRejectedValue(new Error('boom'));
    const b = renderModal({ kind: 'request', request: request() });
    await pick('w-martin');
    expect(await screen.findByTestId('sustitucion-cubrir-verificacion-error')).toHaveTextContent('No se pudo verificar el horario de la persona.');
    expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeDisabled();
    b.unmount();

    let resolve: (v: unknown) => void = () => undefined;
    preview.mockImplementation(() => new Promise((r) => (resolve = r)));
    renderModal({ kind: 'request', request: request() });
    await pick('w-martin');
    expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeDisabled();
    resolve({ shifts: [], conflicts: [], statusAfter: null });
    await waitFor(() => expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeDisabled()); // sem turnos para cobrir ≠ verificado
  });

  it('erro do `cover` por CÓDIGO (traduzido, modal aberto) e sem código/desconhecido (mensagem genérica); pool com falha: aviso', async () => {
    cover.mockRejectedValueOnce(new ContractedServiceApiError('x', 409, { code: 'NOTHING_TO_COVER' }));
    const { props } = renderModal({ kind: 'request', request: request() });
    await pick('w-martin');
    await waitFor(() => expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeEnabled());
    fireEvent.click(screen.getByTestId('sustitucion-cubrir-confirmar'));
    expect(await screen.findByTestId('sustitucion-cubrir-error')).toHaveTextContent('No queda ningún turno sin cubrir en este pedido.');
    expect(props.onDone).not.toHaveBeenCalled();
    cover.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByTestId('sustitucion-cubrir-confirmar'));
    await waitFor(() => expect(screen.getByTestId('sustitucion-cubrir-error')).toHaveTextContent('No se pudo asignar a la persona. Probá de nuevo.'));
    cover.mockRejectedValueOnce(new ContractedServiceApiError('x', 409, { code: 'SEM_TRADUCAO' }));
    fireEvent.click(screen.getByTestId('sustitucion-cubrir-confirmar'));
    await waitFor(() => expect(screen.getByTestId('sustitucion-cubrir-error')).not.toHaveTextContent('SEM_TRADUCAO'));
  });

  it('candidato sem a célula de nome: "Prestador sin nombre · …" na lista e na nota de conflito', async () => {
    states = { 'w-0000-sem-nome-aaaa1111|2026-11-02': 'conflict' };
    allocationOptions.mockResolvedValue({ vacancyId: 'v', options: [{ workerId: 'w-0000-sem-nome-aaaa1111', displayName: null, vacancyId: 'v', status: 'SELECTED' }] });
    renderModal({ kind: 'request', request: request() });
    await screen.findByRole('option', { name: 'Prestador sin nombre · aaaa1111' });
    fireEvent.change(screen.getByTestId('sustitucion-cubrir-persona'), { target: { value: 'w-0000-sem-nome-aaaa1111' } });
    expect(await screen.findByTestId('sustitucion-cubrir-conflicto-2026-11-02|sl-a-1')).toHaveTextContent('Prestador ya atiende a otro paciente');
  });

  it('pool que não carregou: aviso; X, Cancelar e Esc fecham', async () => {
    allocationOptions.mockRejectedValue(new Error('boom'));
    const { props } = renderModal({ kind: 'request', request: request() });
    expect(await screen.findByTestId('sustitucion-cubrir-candidatos-error')).toHaveTextContent('No se pudo cargar la lista de quién puede cubrir.');
    fireEvent.click(screen.getByTestId('sustitucion-cubrir-cancelar'));
    fireEvent.click(screen.getByTestId('substitucion-cerrar'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(3);
  });
});

describe('CoverSubstituteModal — a falta de UM turno (tabela)', () => {
  it('turno de um pedido: pré-visão ONE_DAY do dia COM `ignoreRequestId`, só o turno da faixa conta; confirmar grava na falta (`setAbsenceSubstitute`)', async () => {
    previewShifts = [shift('2026-11-04', 'a-2', 'sl-a-2'), shift('2026-11-04', 'a-9', 'sl-outra-faixa')];
    const { props } = renderModal({ kind: 'absence', event: EVENT });
    await pick('w-martin');
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', { type: 'ONE_DAY', outgoingWorkerId: 'w-out', from: '2026-11-04', ignoreRequestId: 'rq-1', candidateWorkerIds: ['w-martin'] });
    await waitFor(() => expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeEnabled());
    expect(screen.getAllByTestId(/^sustitucion-cubrir-turno-/)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('sustitucion-cubrir-confirmar'));
    await waitFor(() => expect(props.onDone).toHaveBeenCalled());
    expect(setAbsenceSubstitute).toHaveBeenCalledWith('p-1', 's-1', 'ab-2', 'w-martin');
    expect(cover).not.toHaveBeenCalled();
  });

  it('falta de ANTES dos pedidos (sem requestId): não há como ignorá-la na pré-visão — sem pré-visão, vale a barreira final do banco; o erro dele vem traduzido', async () => {
    setAbsenceSubstitute.mockRejectedValueOnce(new ContractedServiceApiError('x', 409, { code: 'ITINERARY_OVERLAP' }));
    renderModal({ kind: 'absence', event: { ...EVENT, requestId: null } });
    await pick('w-martin');
    expect(preview).not.toHaveBeenCalled();
    expect(screen.getByTestId('sustitucion-cubrir-confirmar')).toBeEnabled();
    fireEvent.click(screen.getByTestId('sustitucion-cubrir-confirmar'));
    expect(await screen.findByTestId('sustitucion-cubrir-error')).toHaveTextContent('El prestador ya tiene otra franja que se superpone con este horario.');
  });
});
