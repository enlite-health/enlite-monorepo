/**
 * NewSubstitutionFlow — spec 069, US3-US6 (mockup `modal-resumen.png`): 4 passos, "Paso N de 4". O servidor responde (turnos,
 * conflito tri-estado, estado novo); a tela coleta a escolha. A prova que importa: o passo 3 abre SEM escolha e "Siguiente" só habilita
 * com TODO turno resolvido e livre; o POST leva o substituto OBRIGATÓRIO (pessoa ou null) em cada turno.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AdminSubstitutionRequestsApiService } from '@infrastructure/http/AdminSubstitutionRequestsApiService';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import { initI18n } from './i18nSetup';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';
import { NewSubstitutionFlow } from '../NewSubstitutionFlow';

vi.mock('@infrastructure/http/AdminSubstitutionRequestsApiService', () => ({
  AdminSubstitutionRequestsApiService: { outgoingOptions: vi.fn(), preview: vi.fn(), create: vi.fn() },
}));
vi.mock('@infrastructure/http/AdminContractedServicesApiService', async () => {
  const actual = await vi.importActual<typeof import('@infrastructure/http/AdminContractedServicesApiService')>('@infrastructure/http/AdminContractedServicesApiService');
  return { ...actual, AdminContractedServicesApiService: { getAllocationOptions: vi.fn() } };
});
let reasonCatalog: { options: Array<{ code: string; label: string }>; status: 'ok' | 'error' } = { options: [], status: 'ok' };
vi.mock('@hooks/admin/useServiceExitReasonOptions', () => ({ useServiceExitReasonOptions: () => reasonCatalog }));

const outgoingOptions = AdminSubstitutionRequestsApiService.outgoingOptions as ReturnType<typeof vi.fn>;
const preview = AdminSubstitutionRequestsApiService.preview as ReturnType<typeof vi.fn>;
const create = AdminSubstitutionRequestsApiService.create as ReturnType<typeof vi.fn>;
const allocationOptions = AdminContractedServicesApiService.getAllocationOptions as ReturnType<typeof vi.fn>;

beforeAll(async () => {
  await initI18n('es');
});

const AS_OF = '2026-10-21';
type Body = { type: string; from: string; to?: string; candidateWorkerIds: string[]; ignoreRequestId?: string };
/** Estado de conflito por (pessoa|data); o que não está aqui é livre. */
let conflictStates: Record<string, 'conflict' | 'unknown' | 'free'>;
let previewFail: { code?: string } | null;
let permanentExtra: Record<string, unknown>;

function previewImpl(body: Body) {
  if (previewFail !== null) return Promise.reject(previewFail.code ? new ContractedServiceApiError('x', 422, { code: previewFail.code }) : new Error('boom'));
  const dates = body.type === 'DAYS' ? [body.from, body.to as string] : body.type === 'PERMANENT' ? [body.from, body.from] : [body.from];
  const shifts = dates.map((date, i) => ({ date, slotId: `sl-${i}`, assignmentId: `al-${i}`, startTime: '09:00', endTime: '17:00' }));
  const conflicts = body.candidateWorkerIds.flatMap((workerId) =>
    shifts.map((s) => {
      const state = conflictStates[`${workerId}|${s.date}`] ?? 'free';
      return { workerId, date: s.date, slotId: s.slotId, state, overlaps: state === 'conflict' ? [{ weekday: 1, startTime: '10:00', durationMinutes: 240, sameAddress: false }] : [] };
    }),
  );
  return Promise.resolve({
    shifts, conflicts, statusAfter: { current: 'ACTIVE', after: 'SEARCHING', changes: body.type === 'PERMANENT' },
    ...(body.type === 'PERMANENT' ? { permanent: { allocationCount: 2, cancelledAbsences: 3, clearedSubstitutes: 1, pendingEntry: false, scheduledExit: null, ...permanentExtra } } : {}),
  });
}

beforeEach(() => {
  reasonCatalog = { options: [{ code: 'VACATION', label: 'Vacaciones' }, { code: 'OTHER', label: 'Otro' }], status: 'ok' };
  conflictStates = {};
  previewFail = null;
  permanentExtra = {};
  outgoingOptions.mockReset().mockResolvedValue([{ workerId: 'w-lucia', displayName: 'Lucía Fernández' }, { workerId: 'w-ana', displayName: 'Ana Ruiz' }]);
  allocationOptions.mockReset().mockResolvedValue({
    vacancyId: 'v-1',
    options: [
      { workerId: 'w-lucia', displayName: 'Lucía Fernández', vacancyId: 'v', status: 'IN_SERVICE' },
      { workerId: 'w-martin', displayName: 'Martín Gómez', vacancyId: 'v', status: 'QUICK_RESPONSE' },
      { workerId: 'w-bia', displayName: 'Bia Costa', vacancyId: 'v', status: 'SELECTED' },
    ],
  });
  preview.mockReset().mockImplementation((_p: string, _s: string, body: Body) => previewImpl(body));
  create.mockReset().mockResolvedValue({ requestId: 'rq-new', type: 'DAYS', from: '2026-11-09', to: '2026-11-20', shiftCount: 2 });
});

function renderFlow(over: Partial<React.ComponentProps<typeof NewSubstitutionFlow>> = {}) {
  const props = { patientId: 'p-1', serviceId: 's-1', asOf: AS_OF, prefill: null, onClose: vi.fn(), onCreated: vi.fn(), ...over };
  return { ...render(<NewSubstitutionFlow {...props} />), props };
}

const next = () => fireEvent.click(screen.getByTestId('substitucion-siguiente'));
const radioOf = (testId: string) => within(screen.getByTestId(testId)).getByRole('radio');
const setDate = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

async function goToStep3(type: 'ONE_DAY' | 'DAYS' | 'PERMANENT' = 'DAYS') {
  const view = renderFlow();
  fireEvent.click(await withinRadio('substitucion-quien-w-lucia'));
  next();
  fireEvent.click(radioOf(`substitucion-duracion-${type}`));
  if (type === 'DAYS') {
    setDate('substitucion-desde', '2026-11-09');
    setDate('substitucion-hasta', '2026-11-20');
  } else {
    setDate('substitucion-fecha', type === 'PERMANENT' ? '2026-12-01' : '2026-11-09');
  }
  await screen.findByTestId('substitucion-turnos-cuenta');
  next();
  return view;
}

async function withinRadio(testId: string): Promise<HTMLElement> {
  const card = await screen.findByTestId(testId);
  return within(card).getByRole('radio');
}

async function goToStep4(mode: 'nobody' | 'one', type: 'DAYS' | 'PERMANENT' = 'DAYS') {
  const view = await goToStep3(type);
  if (mode === 'nobody') fireEvent.click(radioOf('substitucion-cobertura-nobody'));
  else {
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-martin' } });
  }
  await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
  next();
  return view;
}

describe('Passo 1 — ¿Quién no va a venir?', () => {
  it('"Paso 1 de 4" com a régua de 4 barras (1 acesa); UMA linha por pessoa; "Atrás" desabilitado; "Siguiente" só depois de marcar', async () => {
    const { container } = renderFlow();
    expect(await screen.findByTestId('substitucion-quien-w-lucia')).toHaveTextContent('Lucía Fernández');
    expect(screen.getByTestId('substitucion-paso')).toHaveTextContent('Paso 1 de 4');
    expect([1, 2, 3, 4].map((i) => screen.getByTestId(`substitucion-barra-${i}`).getAttribute('data-on'))).toEqual(['true', 'false', 'false', 'false']);
    expect(screen.getByRole('heading', { name: '¿Quién no va a venir?' })).toBeInTheDocument();
    expect(screen.getAllByTestId(/^substitucion-quien-w-/)).toHaveLength(2);
    expect(within(screen.getByTestId('substitucion-quien-w-ana')).getByTestId('person-avatar')).toHaveTextContent('AR');
    expect(screen.getByTestId('substitucion-atras')).toBeDisabled();
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    expect(outgoingOptions).toHaveBeenCalledWith('p-1', 's-1');
    fireEvent.click(radioOf('substitucion-quien-w-lucia'));
    expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled();
    expectNoRawEnumLeaks(container);
  });

  it('carregando, erro e serviço sem ninguém: mensagens de produto e nada para marcar', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    outgoingOptions.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const a = renderFlow();
    expect(screen.getByTestId('substitucion-quien-cargando')).toHaveTextContent('Cargando las personas del servicio…');
    resolve([]);
    expect(await screen.findByTestId('substitucion-quien-vacio')).toHaveTextContent('Este servicio no tiene a nadie con turnos para sustituir.');
    a.unmount();
    outgoingOptions.mockRejectedValueOnce(new Error('boom'));
    renderFlow();
    expect(await screen.findByTestId('substitucion-quien-error')).toHaveAttribute('role', 'alert');
  });

  it('Esc e o X fecham o fluxo (o clique no fundo NÃO — 4 passos não se perdem por um clique torto)', async () => {
    const { props } = renderFlow();
    await screen.findByTestId('substitucion-quien-w-lucia');
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('substitucion-cerrar'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: 'a' });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});

describe('Passo 2 — ¿Por cuánto tiempo?', () => {
  async function toStep2Now() {
    const view = renderFlow();
    fireEvent.click(await withinRadio('substitucion-quien-w-lucia'));
    next();
    return view;
  }

  it('3 opções (Un solo día · Varios días · No vuelve más) sem "parte de un turno"; nada marcado; "Siguiente" desabilitado', async () => {
    const { container } = await toStep2Now();
    expect(screen.getByTestId('substitucion-paso')).toHaveTextContent('Paso 2 de 4');
    expect(screen.getAllByTestId(/^substitucion-duracion-/).map((el) => el.textContent)).toEqual([
      'Un solo díaFalta un día completo.',
      'Varios díasVacaciones, licencia.',
      'No vuelve másDeja el servicio.',
    ]);
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    expect(container).not.toHaveTextContent(/parte de un turno/i);
    expect(preview).not.toHaveBeenCalled();
    expectNoRawEnumLeaks(container);
  });

  it('Varios días: "Lucía tiene 2 turnos en esas fechas" + os chips vêm da PRÉ-VISÃO (nunca calculados no front); "Siguiente" habilita', async () => {
    await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-DAYS'));
    setDate('substitucion-desde', '2026-11-09');
    setDate('substitucion-hasta', '2026-11-20');
    expect(await screen.findByTestId('substitucion-turnos-cuenta')).toHaveTextContent('Lucía tiene 2 turnos en esas fechas');
    expect(within(screen.getByTestId('substitucion-turnos')).getAllByText(/·/).map((c) => c.textContent)).toEqual(['Lun 09 · 09–17', 'Vie 20 · 09–17']);
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', { type: 'DAYS', outgoingWorkerId: 'w-lucia', from: '2026-11-09', to: '2026-11-20', candidateWorkerIds: [] });
    expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled();
  });

  it('Un solo día com 1 turno: singular; mudar de opção e voltar não mantém a cobertura de antes', async () => {
    await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-ONE_DAY'));
    setDate('substitucion-fecha', '2026-11-09');
    expect(await screen.findByTestId('substitucion-turnos-cuenta')).toHaveTextContent('Lucía tiene 1 turno en esas fechas');
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', { type: 'ONE_DAY', outgoingWorkerId: 'w-lucia', from: '2026-11-09', candidateWorkerIds: [] });
  });

  it('data PASSADA: bloqueia ANTES de enviar (nenhuma pré-visão, "Siguiente" desabilitado, mensagem traduzida)', async () => {
    await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-ONE_DAY'));
    setDate('substitucion-fecha', '2026-10-20');
    expect(screen.getByTestId('substitucion-periodo-pasado')).toHaveTextContent('La fecha ya pasó. Elegí hoy o una fecha futura.');
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    expect(preview).not.toHaveBeenCalled();
  });

  it('"Hasta" antes de "Desde": mensagem, bloqueado, nenhuma pré-visão; só "Desde" digitado: espera', async () => {
    await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-DAYS'));
    setDate('substitucion-desde', '2026-11-09');
    expect(screen.queryByTestId('substitucion-periodo-invertido')).toBeNull();
    setDate('substitucion-hasta', '2026-11-02');
    expect(screen.getByTestId('substitucion-periodo-invertido')).toHaveTextContent('La fecha final es anterior a la inicial.');
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    expect(preview).not.toHaveBeenCalled();
  });

  it('período SEM turno da pessoa: a mensagem do servidor (traduzida por CÓDIGO) e bloqueio; falha sem código: mensagem genérica; nunca o código cru', async () => {
    previewFail = { code: 'SUBSTITUTION_NO_SHIFTS_IN_PERIOD' };
    const { container, unmount } = await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-ONE_DAY'));
    setDate('substitucion-fecha', '2026-11-10');
    expect(await screen.findByTestId('substitucion-turnos-error')).toHaveTextContent('Esa persona no tiene turnos en el período elegido.');
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    expect(container).not.toHaveTextContent('SUBSTITUTION_NO_SHIFTS_IN_PERIOD');
    unmount();
    previewFail = {};
    await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-ONE_DAY'));
    setDate('substitucion-fecha', '2026-11-10');
    expect(await screen.findByTestId('substitucion-turnos-error')).toHaveTextContent('No se pudieron verificar los turnos. Probá de nuevo.');
  });

  it('enquanto a pré-visão carrega: "Buscando los turnos…" e "Siguiente" desabilitado', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    preview.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-ONE_DAY'));
    setDate('substitucion-fecha', '2026-11-09');
    expect(screen.getByTestId('substitucion-turnos-cargando')).toHaveTextContent('Buscando los turnos de esa persona…');
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    resolve(await previewImpl({ type: 'ONE_DAY', from: '2026-11-09', candidateWorkerIds: [] }));
    await screen.findByTestId('substitucion-turnos-cuenta');
  });

  it('No vuelve más: "sale de 2 franjas" (sem chips), D de hoje vale; entrada futura bloqueante (P5) = mensagem e bloqueio', async () => {
    await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-PERMANENT'));
    setDate('substitucion-fecha', '2026-12-01');
    expect(await screen.findByTestId('substitucion-turnos-cuenta')).toHaveTextContent('Lucía sale de 2 franjas de este servicio');
    expect(screen.queryByTestId('substitucion-turnos')).toBeNull();
    expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled();
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', { type: 'PERMANENT', outgoingWorkerId: 'w-lucia', from: '2026-12-01', candidateWorkerIds: [] });
  });

  it('P5: com entrada futura no serviço o "No vuelve más" é recusado já na tela', async () => {
    permanentExtra = { pendingEntry: true };
    await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-PERMANENT'));
    setDate('substitucion-fecha', '2026-12-01');
    expect(await screen.findByTestId('substitucion-entrada-pendiente')).toHaveTextContent('Esa persona tiene una entrada futura en este servicio.');
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
  });

  it('D1: pessoa com saída agendada → mensagem es com a data DD/MM e "Siguiente" bloqueado; sem saída agendada o mesmo passo avança (controle)', async () => {
    permanentExtra = { scheduledExit: '2026-11-15' };
    await toStep2Now();
    fireEvent.click(radioOf('substitucion-duracion-PERMANENT'));
    setDate('substitucion-fecha', '2026-12-01');
    expect(await screen.findByTestId('substitucion-salida-programada')).toHaveTextContent(
      'Esta persona ya tiene una salida programada para el 15/11. Deshacé esa sustitución para cambiar la fecha.',
    );
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
  });

  it('"Atrás" volta ao passo 1 mantendo a pessoa', async () => {
    await toStep2Now();
    fireEvent.click(screen.getByTestId('substitucion-atras'));
    expect(screen.getByTestId('substitucion-paso')).toHaveTextContent('Paso 1 de 4');
    expect(radioOf('substitucion-quien-w-lucia')).toBeChecked();
  });
});

describe('Passo 3 — ¿Quién la cubre? (P16: abre SEM escolha)', () => {
  it('T609 abre sem NENHUMA opção marcada e "Siguiente" desabilitado; "Nadie todavía" é uma escolha EXPLÍCITA que habilita', async () => {
    const { container } = await goToStep3();
    expect(screen.getByTestId('substitucion-paso')).toHaveTextContent('Paso 3 de 4');
    expect(screen.getByRole('heading', { name: '¿Quién la cubre?' })).toBeInTheDocument();
    for (const mode of ['one', 'perDay', 'nobody']) expect(radioOf(`substitucion-cobertura-${mode}`)).not.toBeChecked();
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    fireEvent.click(radioOf('substitucion-cobertura-nobody'));
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
    expect(screen.getByTestId('substitucion-cobertura-nobody')).toHaveTextContent('Los turnos quedan sin cubrir.');
    expectNoRawEnumLeaks(container);
  });

  it('o pool NÃO traz o próprio titular; "Una persona": escolher mostra avatar, papel e o conflito POR DIA (livre → "Libre"), e habilita', async () => {
    await goToStep3();
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    const select = screen.getByTestId('substitucion-persona');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Elegir persona', 'Martín Gómez', 'Bia Costa']);
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    fireEvent.change(select, { target: { value: 'w-martin' } });
    expect(screen.getByTestId('substitucion-persona-elegida')).toHaveTextContent('Martín Gómez');
    expect(screen.getByTestId('substitucion-persona-elegida')).toHaveTextContent('Equipo de Respuesta Rápida');
    await waitFor(() => expect(screen.getByTestId('substitucion-estado-2026-11-09|sl-0')).toHaveAttribute('data-state', 'free'));
    expect(screen.getByTestId('substitucion-estado-2026-11-09|sl-0')).toHaveTextContent('Libre');
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', expect.objectContaining({ candidateWorkerIds: ['w-martin'] }));
  });

  it('CONFLITO: "Martín ya atiende a otro paciente el lunes de 10:00 a 14:00", "Conflicto", "Siguiente" bloqueado; "Nadie todavía" NAQUELE dia desbloqueia', async () => {
    conflictStates = { 'w-martin|2026-11-09': 'conflict' };
    await goToStep3();
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-martin' } });
    const note = await screen.findByTestId('substitucion-conflicto-2026-11-09|sl-0');
    expect(note).toHaveTextContent('Martín ya atiende a otro paciente el lunes de 10:00 a 14:00.');
    expect(note).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('substitucion-estado-2026-11-09|sl-0')).toHaveTextContent('Conflicto');
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    expect(screen.getByTestId('substitucion-bloqueo')).toHaveTextContent('Resolvé cada día para continuar.');
    fireEvent.change(screen.getByTestId('substitucion-elegir-2026-11-09|sl-0'), { target: { value: '__nobody__' } });
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
    expect(screen.queryByTestId('substitucion-conflicto-2026-11-09|sl-0')).toBeNull();
  });

  it('CONFLITO resolvido trocando a pessoa NAQUELE dia: a outra pessoa também passa pela pré-visão (e livre)', async () => {
    conflictStates = { 'w-martin|2026-11-09': 'conflict' };
    await goToStep3();
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-martin' } });
    await screen.findByTestId('substitucion-conflicto-2026-11-09|sl-0');
    const pick = screen.getByTestId('substitucion-elegir-2026-11-09|sl-0');
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['Elegir otra persona para ese día', 'Nadie todavía', 'Bia Costa']);
    fireEvent.change(pick, { target: { value: 'w-bia' } });
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
    expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', expect.objectContaining({ candidateWorkerIds: ['w-bia', 'w-martin'] }));
  });

  it('verificação que FALHOU (`unknown`) nunca vale como livre: "No se pudo verificar" e "Siguiente" bloqueado', async () => {
    conflictStates = { 'w-martin|2026-11-20': 'unknown' };
    await goToStep3();
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-martin' } });
    expect(await screen.findByTestId('substitucion-estado-2026-11-20|sl-1')).toHaveTextContent('No se pudo verificar');
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
  });

  it('a chamada de conflito inteira falhou: "No se pudo verificar" em cada dia + aviso; bloqueado', async () => {
    await goToStep3();
    preview.mockImplementation((_p: string, _s: string, body: Body) => (body.candidateWorkerIds.length > 0 ? Promise.reject(new Error('boom')) : previewImpl(body)));
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-martin' } });
    expect(await screen.findByTestId('substitucion-conflicto-error')).toHaveTextContent('No se pudo verificar el horario de la persona. Probá de nuevo.');
    expect(screen.getByTestId('substitucion-estado-2026-11-09|sl-0')).toHaveTextContent('No se pudo verificar');
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
  });

  it('enquanto a verificação não respondeu: "Verificando…" e bloqueado (nunca livre por padrão)', async () => {
    await goToStep3();
    let resolve: (v: unknown) => void = () => undefined;
    preview.mockImplementation((_p: string, _s: string, body: Body) => (body.candidateWorkerIds.length > 0 ? new Promise((r) => (resolve = r)) : previewImpl(body)));
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-martin' } });
    expect(await screen.findByTestId('substitucion-estado-2026-11-09|sl-0')).toHaveTextContent('Verificando…');
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    resolve(await previewImpl({ type: 'DAYS', from: '2026-11-09', to: '2026-11-20', candidateWorkerIds: ['w-martin'] }));
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
  });

  it('"Una persona por día": cada turno exige a sua escolha (pessoa ou "Nadie todavía"); só habilita com TODOS resolvidos', async () => {
    await goToStep3();
    fireEvent.click(radioOf('substitucion-cobertura-perDay'));
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    const first = screen.getByTestId('substitucion-elegir-2026-11-09|sl-0');
    const second = screen.getByTestId('substitucion-elegir-2026-11-20|sl-1');
    expect(first).toHaveAttribute('aria-label', 'Quién cubre el Lun 09 · 09–17');
    fireEvent.change(first, { target: { value: 'w-martin' } });
    await waitFor(() => expect(screen.getByTestId('substitucion-estado-2026-11-09|sl-0')).toHaveTextContent('Libre'));
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    fireEvent.change(second, { target: { value: '__nobody__' } });
    expect(screen.getByTestId('substitucion-turno-2026-11-20|sl-1')).toHaveTextContent('Nadie todavía');
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
    fireEvent.change(second, { target: { value: '' } }); // voltar ao placeholder não resolve nada
    expect(screen.getByTestId('substitucion-turno-2026-11-20|sl-1')).toHaveTextContent('Nadie todavía');
  });

  it('"No vuelve más" não oferece "uma pessoa por día" (o pedido leva UMA pessoa para todas as franjas)', async () => {
    await goToStep3('PERMANENT');
    expect(screen.queryByTestId('substitucion-cobertura-perDay')).toBeNull();
    expect(screen.getByTestId('substitucion-cobertura-one')).toBeInTheDocument();
  });

  it('mudar a pessoa do "Una persona" zera as exceções por dia; o pool não carregou → aviso; carregando → texto', async () => {
    conflictStates = { 'w-martin|2026-11-09': 'conflict' };
    await goToStep3();
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-martin' } });
    fireEvent.change(await screen.findByTestId('substitucion-elegir-2026-11-09|sl-0'), { target: { value: '__nobody__' } });
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-bia' } });
    await waitFor(() => expect(screen.getByTestId('substitucion-estado-2026-11-09|sl-0')).toHaveTextContent('Libre'));
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: '' } });
    expect(screen.queryByTestId('substitucion-persona-elegida')).toBeNull();
  });

  it('pool com falha: aviso e só "Nadie todavía" possível; pool carregando: texto', async () => {
    allocationOptions.mockRejectedValue(new Error('boom'));
    await goToStep3();
    expect(await screen.findByTestId('substitucion-candidatos-error')).toHaveTextContent('No se pudo cargar la lista de quién puede cubrir.');
    fireEvent.click(radioOf('substitucion-cobertura-nobody'));
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
  });

  it('pool ainda carregando: "Cargando quién puede cubrir…"', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    allocationOptions.mockImplementation(() => new Promise((r) => (resolve = r)));
    await goToStep3();
    expect(screen.getByTestId('substitucion-candidatos-cargando')).toHaveTextContent('Cargando quién puede cubrir…');
    resolve({ options: [] });
    await screen.findByTestId('substitucion-cobertura-one');
  });
});

describe('Passo 4 — Motivo y resumen', () => {
  it('"Nadie todavía" em Varios días: motivo OBRIGATÓRIO (Confirmar desabilitado), resumo com o bloco Sale → Entra, período e turnos', async () => {
    const { container } = await goToStep4('nobody');
    expect(screen.getByTestId('substitucion-paso')).toHaveTextContent('Paso 4 de 4');
    expect(screen.getByRole('heading', { name: 'Motivo y resumen' })).toBeInTheDocument();
    expect(screen.getByTestId('substitucion-confirmar')).toBeDisabled();
    expect(within(screen.getByTestId('substitucion-motivo')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Motivo del cambio', 'Vacaciones', 'Otro']);
    fireEvent.change(screen.getByTestId('substitucion-motivo'), { target: { value: 'VACATION' } });
    expect(screen.getByTestId('substitucion-confirmar')).toBeEnabled();
    const summary = screen.getByTestId('substitucion-resumen');
    expect(summary).toHaveTextContent('Vas a registrar:');
    expect(screen.getByTestId('substitucion-resumen-periodo')).toHaveTextContent('9 al 20 de noviembre · 2 turnos');
    const block = screen.getByTestId('substitucion-resumen-bloque');
    expect(within(block).getByRole('img', { name: 'Sale' })).toBeInTheDocument();
    expect(within(block).getByRole('img', { name: 'Entra' })).toBeInTheDocument();
    expect(block).toHaveTextContent('Lucía Fernández');
    expect(block).toHaveTextContent('Vacaciones');
    expect(block).toHaveTextContent('Nadie todavía');
    expect(screen.queryByTestId('substitucion-resumen-sin-cubrir')).toBeNull(); // a frase "A partir del…" é do permanente
    expectNoRawEnumLeaks(container);
  });

  it('confirmar envia UM POST com o contrato: período, motivo e cada turno com `substituteWorkerId` (null = Nadie todavía); sucesso chama onCreated', async () => {
    const { props } = await goToStep4('nobody');
    fireEvent.change(screen.getByTestId('substitucion-motivo'), { target: { value: 'VACATION' } });
    fireEvent.click(screen.getByTestId('substitucion-confirmar'));
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('p-1', 's-1', {
      type: 'DAYS', outgoingWorkerId: 'w-lucia', from: '2026-11-09', to: '2026-11-20', reasonCategory: 'VACATION',
      shifts: [{ date: '2026-11-09', slotId: 'sl-0', substituteWorkerId: null }, { date: '2026-11-20', slotId: 'sl-1', substituteWorkerId: null }],
    });
  });

  it('com substituto: o bloco mostra a pessoa e o PAPEL ("Respuesta rápida"); o POST leva o id dela em cada turno', async () => {
    const { props } = await goToStep4('one');
    fireEvent.change(screen.getByTestId('substitucion-motivo'), { target: { value: 'OTHER' } });
    const block = screen.getByTestId('substitucion-resumen-bloque');
    expect(block).toHaveTextContent('Martín Gómez');
    expect(screen.getByTestId('substitucion-resumen-bloque-papel')).toHaveTextContent('Respuesta rápida');
    expect(block).not.toHaveTextContent('salvo');
    fireEvent.click(screen.getByTestId('substitucion-confirmar'));
    await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
    expect(create.mock.calls[0][2].shifts.map((s: { substituteWorkerId: string }) => s.substituteWorkerId)).toEqual(['w-martin', 'w-martin']);
  });

  it('um dia sem ninguém no meio: "salvo lun 9: nadie" no MESMO bloco', async () => {
    conflictStates = { 'w-martin|2026-11-09': 'conflict' };
    await goToStep3();
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-martin' } });
    fireEvent.change(await screen.findByTestId('substitucion-elegir-2026-11-09|sl-0'), { target: { value: '__nobody__' } });
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
    next();
    expect(screen.getByTestId('substitucion-resumen-bloque-salvo')).toHaveTextContent('salvo lun 9: nadie');
  });

  it('um dia só: o período é o dia por extenso ("Lunes 9 de noviembre · 1 turno")', async () => {
    const view = await goToStep3('ONE_DAY');
    fireEvent.click(radioOf('substitucion-cobertura-nobody'));
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
    next();
    expect(screen.getByTestId('substitucion-resumen-periodo')).toHaveTextContent('Lunes 9 de noviembre · 1 turno');
    view.unmount();
  });

  it('"No vuelve más" sem substituto: "A partir del 01/12 los turnos quedan Sin cubrir", estado novo, "Se cancelan 3 sustituciones…" e as franjas; destino NÃO é perguntado (D ≠ hoje)', async () => {
    await goToStep4('nobody', 'PERMANENT');
    expect(screen.getByTestId('substitucion-resumen-periodo')).toHaveTextContent('Desde el 1 de diciembre · 2 franjas');
    expect(screen.getByTestId('substitucion-resumen-sin-cubrir')).toHaveTextContent('A partir del 01/12 los turnos quedan Sin cubrir');
    expect(screen.getByTestId('substitucion-resumen-estado')).toHaveTextContent('El estado del paciente pasa de Activo a Búsqueda.');
    expect(screen.getByTestId('substitucion-resumen-canceladas')).toHaveTextContent('Se cancelan 3 sustituciones ya cargadas desde esa fecha');
    expect(screen.getByTestId('substitucion-resumen-limpias')).toHaveTextContent('1 turno en el que cubría queda Sin cubrir');
    expect(screen.queryByTestId('substitucion-destino')).toBeNull();
    fireEvent.change(screen.getByTestId('substitucion-motivo'), { target: { value: 'OTHER' } });
    fireEvent.click(screen.getByTestId('substitucion-confirmar'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith('p-1', 's-1', { type: 'PERMANENT', outgoingWorkerId: 'w-lucia', from: '2026-12-01', reasonCategory: 'OTHER', substituteWorkerId: null });
  });

  it('estado atual desconhecido (null): "El estado del paciente pasa a Búsqueda." (sem inventar o "de")', async () => {
    preview.mockImplementation((_p: string, _s: string, body: Body) => previewImpl(body).then((r) => ({ ...r, statusAfter: { current: null, after: 'SEARCHING', changes: true } })));
    await goToStep4('nobody', 'PERMANENT');
    expect(screen.getByTestId('substitucion-resumen-estado')).toHaveTextContent('El estado del paciente pasa a Búsqueda.');
  });

  it('"No vuelve más" COM substituto: não diz "quedan Sin cubrir" nem estado novo (alguém entra); singular de "sustitución"', async () => {
    permanentExtra = { cancelledAbsences: 1, clearedSubstitutes: 0 };
    await goToStep4('one', 'PERMANENT');
    expect(screen.queryByTestId('substitucion-resumen-sin-cubrir')).toBeNull();
    expect(screen.queryByTestId('substitucion-resumen-estado')).toBeNull();
    expect(screen.getByTestId('substitucion-resumen-canceladas')).toHaveTextContent('Se cancela 1 sustitución ya cargada desde esa fecha');
    expect(screen.queryByTestId('substitucion-resumen-limpias')).toBeNull();
  });

  it('"No vuelve más" sem mudança de estado (changes=false) e sem faltas: nenhuma dessas linhas', async () => {
    preview.mockImplementation((_p: string, _s: string, body: Body) =>
      previewImpl(body).then((r) => ({ ...r, statusAfter: { current: 'ACTIVE', after: 'ACTIVE', changes: false }, ...(r.permanent ? { permanent: { ...r.permanent, cancelledAbsences: 0, clearedSubstitutes: 0 } } : {}) })),
    );
    await goToStep4('nobody', 'PERMANENT');
    expect(screen.getByTestId('substitucion-resumen-sin-cubrir')).toBeInTheDocument();
    expect(screen.queryByTestId('substitucion-resumen-estado')).toBeNull();
    expect(screen.queryByTestId('substitucion-resumen-canceladas')).toBeNull();
  });

  it('P6: com D = HOJE o destino de quem sai é perguntado e OBRIGATÓRIO, e vai no corpo', async () => {
    renderFlow();
    fireEvent.click(await withinRadio('substitucion-quien-w-lucia'));
    next();
    fireEvent.click(radioOf('substitucion-duracion-PERMANENT'));
    setDate('substitucion-fecha', AS_OF);
    await screen.findByTestId('substitucion-turnos-cuenta');
    next();
    fireEvent.click(radioOf('substitucion-cobertura-nobody'));
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
    next();
    fireEvent.change(screen.getByTestId('substitucion-motivo'), { target: { value: 'OTHER' } });
    expect(screen.getByTestId('substitucion-destino')).toBeInTheDocument();
    expect(screen.getByTestId('substitucion-confirmar')).toBeDisabled();
    fireEvent.click(screen.getByTestId('substitucion-destino-RESERVE'));
    expect(screen.getByTestId('substitucion-confirmar')).toBeEnabled();
    fireEvent.click(screen.getByTestId('substitucion-confirmar'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][2]).toMatchObject({ type: 'PERMANENT', from: AS_OF, destination: 'RESERVE', substituteWorkerId: null });
  });

  it('erro do POST por CÓDIGO: mensagem traduzida (nunca o código cru), o modal fica aberto e "Confirmar" volta; código desconhecido/sem código → mensagem genérica', async () => {
    create.mockRejectedValueOnce(new ContractedServiceApiError('x', 409, { code: 'ABSENCE_ALREADY_EXISTS' }));
    const { props, container } = await goToStep4('nobody');
    fireEvent.change(screen.getByTestId('substitucion-motivo'), { target: { value: 'VACATION' } });
    fireEvent.click(screen.getByTestId('substitucion-confirmar'));
    expect(await screen.findByTestId('substitucion-error')).toHaveTextContent('Ya hay una falta cargada en uno de esos turnos.');
    expect(container).not.toHaveTextContent('ABSENCE_ALREADY_EXISTS');
    expect(screen.getByTestId('substitucion-confirmar')).toBeEnabled();
    expect(props.onCreated).not.toHaveBeenCalled();
    create.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByTestId('substitucion-confirmar'));
    await waitFor(() => expect(screen.getByTestId('substitucion-error')).toHaveTextContent('No se pudo registrar la sustitución. Probá de nuevo.'));
    create.mockRejectedValueOnce(new ContractedServiceApiError('x', 409, { code: 'CODIGO_SEM_TRADUCAO' }));
    fireEvent.click(screen.getByTestId('substitucion-confirmar'));
    await waitFor(() => expect(screen.getByTestId('substitucion-error')).toHaveTextContent('No se pudo registrar la sustitución. Probá de nuevo.'));
    expect(screen.getByTestId('substitucion-error')).not.toHaveTextContent('CODIGO_SEM_TRADUCAO');
  });

  it('catálogo de motivos que não carregou: aviso no passo 4 e "Confirmar" segue desabilitado (sem motivo não há pedido)', async () => {
    reasonCatalog = { options: [], status: 'error' };
    await goToStep4('nobody');
    expect(screen.getByTestId('substitucion-motivo-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('substitucion-confirmar')).toBeDisabled();
  });

  it('prestador sem a célula de nome (displayName null) aparece como "Prestador sin nombre · …" no passo 3 e no resumo — nunca em branco nem o id inteiro', async () => {
    allocationOptions.mockResolvedValue({ vacancyId: 'v', options: [{ workerId: 'w-0000-sem-nome-aaaa1111', displayName: null, vacancyId: 'v', status: 'SELECTED' }] });
    await goToStep3();
    fireEvent.click(radioOf('substitucion-cobertura-one'));
    expect(within(screen.getByTestId('substitucion-persona')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Elegir persona', 'Prestador sin nombre · aaaa1111']);
    fireEvent.change(screen.getByTestId('substitucion-persona'), { target: { value: 'w-0000-sem-nome-aaaa1111' } });
    expect(screen.getByTestId('substitucion-persona-elegida')).toHaveTextContent('Prestador sin nombre · aaaa1111');
  });

  it('enquanto o POST corre: "Confirmando…" e o botão desabilitado (sem duplo envio)', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    create.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    const { props } = await goToStep4('nobody');
    fireEvent.change(screen.getByTestId('substitucion-motivo'), { target: { value: 'VACATION' } });
    fireEvent.click(screen.getByTestId('substitucion-confirmar'));
    expect(screen.getByTestId('substitucion-confirmar')).toHaveTextContent('Confirmando…');
    expect(screen.getByTestId('substitucion-confirmar')).toBeDisabled();
    resolve({ requestId: 'x' });
    await waitFor(() => expect(props.onCreated).toHaveBeenCalled());
  });

  it('mudar o período (voltar ao passo 2) zera a cobertura já escolhida — os turnos mudaram', async () => {
    await goToStep4('nobody');
    fireEvent.click(screen.getByTestId('substitucion-atras'));
    fireEvent.click(screen.getByTestId('substitucion-atras'));
    setDate('substitucion-hasta', '2026-11-27');
    await waitFor(() => expect(preview).toHaveBeenLastCalledWith('p-1', 's-1', expect.objectContaining({ to: '2026-11-27' })));
    await waitFor(() => expect(screen.getByTestId('substitucion-siguiente')).toBeEnabled());
    next();
    expect(radioOf('substitucion-cobertura-nobody')).not.toBeChecked();
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
  });
});

describe('"Cambiar" num turno — o fluxo abre com a pessoa e o dia', () => {
  const EVENT: PatientItineraryEvent = {
    date: '2026-11-09', weekday: 1, serviceId: 's-1', slotId: 'sl-0', assignmentId: 'al-0', startTime: '09:00', endTime: '17:00', titularWorkerId: 'w-lucia', titularDisplayName: 'Lucía Fernández',
    status: 'covered', workerId: 'w-lucia', workerDisplayName: 'Lucía Fernández', substituteWorkerId: null, substituteDisplayName: null, absenceId: null, requestId: null,
  };

  it('abre direto no passo 3 com ONE_DAY no dia do turno; "Atrás" mostra o passo 2 já preenchido', async () => {
    renderFlow({ prefill: EVENT });
    expect(screen.getByTestId('substitucion-paso')).toHaveTextContent('Paso 3 de 4');
    await waitFor(() => expect(preview).toHaveBeenCalledWith('p-1', 's-1', { type: 'ONE_DAY', outgoingWorkerId: 'w-lucia', from: '2026-11-09', candidateWorkerIds: [] }));
    await screen.findByTestId('substitucion-cobertura-one');
    for (const mode of ['one', 'perDay', 'nobody']) expect(radioOf(`substitucion-cobertura-${mode}`)).not.toBeChecked(); // P16 também no "Cambiar"
    expect(screen.getByTestId('substitucion-siguiente')).toBeDisabled();
    fireEvent.click(screen.getByTestId('substitucion-atras'));
    expect(radioOf('substitucion-duracion-ONE_DAY')).toBeChecked();
    expect(screen.getByTestId('substitucion-fecha')).toHaveValue('2026-11-09');
  });

  it('sem titular no turno (workerId só): usa quem atende como a pessoa que não vem', async () => {
    renderFlow({ prefill: { ...EVENT, titularWorkerId: null } });
    await waitFor(() => expect(preview).toHaveBeenCalledWith('p-1', 's-1', expect.objectContaining({ outgoingWorkerId: 'w-lucia' })));
  });
});
