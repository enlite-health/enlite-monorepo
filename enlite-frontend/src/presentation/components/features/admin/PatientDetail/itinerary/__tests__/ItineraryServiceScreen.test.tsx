/**
 * ItineraryServiceScreen — spec 069, B2 (mockup b2a.png): "Volver a los servicios", cabeçalho, "Nueva
 * sustitución", "Horas cubiertas", abas Próximos días · Horario fijo · Sustituciones; a tabela mostra
 * SÓ a semana do seletor. O hook de carga é mockado (suíte própria); o resto é i18n real.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { PatientItineraryEvent, PatientItineraryService } from '@domain/entities/PatientItinerary';
import type { UseServiceOccurrencesResult } from '@hooks/admin/useServiceOccurrences';
import { initI18n } from './i18nSetup';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';
import { ItineraryServiceScreen } from '../ItineraryServiceScreen';

const useOccurrences = vi.fn<[string, string, string, number?], UseServiceOccurrencesResult>();
vi.mock('@hooks/admin/useServiceOccurrences', () => ({
  useServiceOccurrences: (...a: [string, string, string, number?]) => useOccurrences(...a),
}));
// O motivo da falta é do PEDIDO: a tela lê a lista de pedidos (mockada aqui; a suíte do hook é própria) e o catálogo de motivos.
const useRequests = vi.fn();
vi.mock('@hooks/admin/useSubstitutionRequests', () => ({ useSubstitutionRequests: (...a: unknown[]) => useRequests(...a) }));
vi.mock('@hooks/admin/useServiceExitReasonOptions', () => ({
  useServiceExitReasonOptions: () => ({ options: [{ code: 'SICK', label: 'Enfermedad' }], status: 'ok' }),
}));

beforeAll(async () => {
  await initI18n('es');
});

const SERVICE: PatientItineraryService = {
  contractedServiceId: 'svc-1',
  scheduleHours: 24,
  cobertas: 16,
  reserve: { count: 3, minimum: 10 },
  providersNeeded: null,
  uncoveredShifts: 1,
  slots: [{ id: 'slot-mon', weekday: 1, startTime: '09:00', endTime: '17:00', durationMinutes: 480, assignments: [] }],
};

function ev(over: Partial<PatientItineraryEvent>): PatientItineraryEvent {
  return {
    date: '2026-10-19', weekday: 1, serviceId: 'svc-1', slotId: 'slot-mon', assignmentId: 'a-1', startTime: '09:00', endTime: '17:00',
    titularWorkerId: 'w-lucia', titularDisplayName: 'Lucía Fernández', status: 'covered', workerId: 'w-lucia', workerDisplayName: 'Lucía Fernández',
    substituteWorkerId: null, substituteDisplayName: null, absenceId: null, requestId: null, ...over,
  };
}
const EVENTS = [
  ev({}),
  ev({ date: '2026-10-21', weekday: 3, slotId: 'slot-wed', status: 'substituted', workerId: 'w-martin', workerDisplayName: 'Martín Gómez', substituteWorkerId: 'w-martin', substituteDisplayName: 'Martín Gómez', absenceId: 'ab-1' }),
  ev({ date: '2026-10-23', weekday: 5, slotId: 'slot-fri', status: 'uncovered', workerId: null, workerDisplayName: null, absenceId: 'ab-2' }),
];

function occurrences(over: Partial<UseServiceOccurrencesResult> = {}): UseServiceOccurrencesResult {
  return { events: EVENTS, status: 'ok', refresh: vi.fn(), ...over };
}

function renderScreen(over: Partial<React.ComponentProps<typeof ItineraryServiceScreen>> = {}) {
  const props = {
    patientId: 'p-1',
    service: SERVICE,
    label: 'Cuidador',
    addressLabel: 'Av. Colón 1234, Córdoba',
    vacancy: { caseNumber: 1412, caseOrdinal: 1 },
    asOf: '2026-10-21', // quarta: a semana corrente é 19-25/10
    canGoBack: true,
    onBack: vi.fn(),
    onSubstitutionFlow: vi.fn(),
    actionError: null,
    onEditSlot: vi.fn(),
    refreshKey: 3,
    ...over,
  };
  return { ...render(<ItineraryServiceScreen {...props} />), props };
}

beforeEach(() => {
  useOccurrences.mockReset().mockReturnValue(occurrences());
  useRequests.mockReset().mockReturnValue({ requests: [], status: 'ok', refresh: vi.fn() });
});

describe('ItineraryServiceScreen — cabeçalho', () => {
  it('nome, endereço, reserva, "Horas cubiertas: 16 de 24 h" e as 3 abas, com "Próximos días" ativa', () => {
    const { container } = renderScreen();
    expect(screen.getByTestId('itinerario-servico-nome')).toHaveTextContent('Cuidador');
    expect(screen.getByTestId('itinerario-servico-tela-svc-1')).toHaveTextContent('Av. Colón 1234, Córdoba');
    expect(screen.getByTestId('itinerario-servico-reserva')).toHaveTextContent('Vacante CASO EN1412#01 · 3 en Respuesta Rápida');
    expect(screen.getByTestId('itinerario-servico-horas')).toHaveTextContent('Horas cubiertas: 16 de 24 h');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Próximos días', 'Horario fijo', 'Sustituciones']);
    expect(screen.getByTestId('itinerario-aba-upcoming')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('itinerario-proximos-painel')).toBeInTheDocument();
    expectNoRawEnumLeaks(container);
  });

  it('(ajuste d) a vaga é o CHIP lilás do mockup — "Vacante CASO EN1412#01 · 3 en Respuesta Rápida" — e não o texto "Equipo de Respuesta Rápida: 3 de 10"', () => {
    renderScreen();
    const chip = screen.getByTestId('itinerario-servico-reserva');
    expect(chip).toHaveTextContent('Vacante CASO EN1412#01 · 3 en Respuesta Rápida');
    expect(chip).toHaveAttribute('data-tone', 'open');
    expect(chip.className).toContain('bg-[#F1E8FF]');
    expect(screen.getByTestId('itinerario-servico-tela-svc-1')).not.toHaveTextContent('Equipo de Respuesta Rápida: 3 de 10');
  });

  it('(ajuste d) vaga sem número de caso legível (ator sem vacancy:read) → "Vacante abierta · N en Respuesta Rápida", sem inventar o caso', () => {
    renderScreen({ vacancy: null });
    expect(screen.getByTestId('itinerario-servico-reserva')).toHaveTextContent('Vacante abierta · 3 en Respuesta Rápida');
  });

  it('serviço sem vaga viva: chip CINZA "Sin vacante abierta"; horário 0 → barra em 0% sem dividir por zero', () => {
    renderScreen({ service: { ...SERVICE, reserve: null, scheduleHours: 0, cobertas: 0 } });
    expect(screen.getByTestId('itinerario-servico-reserva')).toHaveTextContent('Sin vacante abierta');
    expect(screen.getByTestId('itinerario-servico-reserva')).toHaveAttribute('data-tone', 'none');
    expect(screen.getByTestId('itinerario-servico-horas')).toHaveTextContent('Horas cubiertas: 0 de 0 h');
  });

  it('"Volver a los servicios" só existe com mais de um serviço e chama onBack', () => {
    const a = renderScreen();
    fireEvent.click(screen.getByTestId('itinerario-voltar-servicos'));
    expect(a.props.onBack).toHaveBeenCalledTimes(1);
    a.unmount();
    renderScreen({ canGoBack: false });
    expect(screen.queryByTestId('itinerario-voltar-servicos')).toBeNull();
  });

  it('"Nueva sustitución" sobe a intenção { kind: "new" } (o fluxo é da F6)', () => {
    const { props } = renderScreen();
    fireEvent.click(screen.getByTestId('itinerario-nova-substituicao'));
    expect(props.onSubstitutionFlow).toHaveBeenCalledWith({ kind: 'new' });
  });
});

describe('ItineraryServiceScreen — Próximos días', () => {
  it('carrega a SEMANA CORRENTE (segunda de asOf) e repassa a chave de refresh', () => {
    renderScreen();
    expect(useOccurrences).toHaveBeenCalledWith('p-1', 'svc-1', '2026-10-19', 3);
    expect(screen.getByTestId('itinerario-semana-rotulo')).toHaveTextContent('19 al 25 de octubre');
    expect(screen.getByTestId('itinerario-semana-relativo')).toHaveTextContent('Esta semana');
  });

  it('trocar de semana pelo seletor recarrega essa semana; "Ir a esta semana" volta à corrente', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('itinerario-semana-seguinte'));
    expect(useOccurrences).toHaveBeenLastCalledWith('p-1', 'svc-1', '2026-10-26', 3);
    fireEvent.click(screen.getByTestId('itinerario-semana-atual'));
    expect(useOccurrences).toHaveBeenLastCalledWith('p-1', 'svc-1', '2026-10-19', 3);
  });

  it('a tabela mostra os turnos que o hook devolveu (SÓ a semana pedida; nada de outra semana emendado)', () => {
    renderScreen();
    expect(screen.getAllByTestId(/^itinerario-proximo-slot-/)).toHaveLength(3);
  });

  it('"Cambiar"/"Asignar" da tabela sobem as intenções com o turno', () => {
    const { props } = renderScreen();
    fireEvent.click(screen.getByTestId('itinerario-proximo-cambiar-slot-mon-2026-10-19'));
    expect(props.onSubstitutionFlow).toHaveBeenLastCalledWith({ kind: 'change', event: EVENTS[0] });
    fireEvent.click(screen.getByTestId('itinerario-proximo-asignar-slot-fri-2026-10-23'));
    expect(props.onSubstitutionFlow).toHaveBeenLastCalledWith({ kind: 'assign', event: EVENTS[2] });
  });

  it('(ajuste a) o filtro é o Select do design system, NA LINHA do seletor de semana (junto de "Ir a esta semana"), e não um <select> solto numa linha própria', () => {
    renderScreen();
    const row = screen.getByTestId('itinerario-semana');
    const select = within(row).getByTestId('itinerario-filtro-prestador');
    expect(within(row).getByTestId('itinerario-semana-atual')).toBeInTheDocument();
    expect(within(row).getByTestId('itinerario-semana-rotulo')).toBeInTheDocument();
    expect(within(row).getByLabelText('Prestador')).toBe(select);
    // o átomo `Select` desenha o campo (borda do input, chevron); o `<select>` cru não tinha nem um nem outro
    expect(select.parentElement?.querySelector('svg')).not.toBeNull();
    expect(select.parentElement?.className).toContain('border-[1.5px]');
    // mesmo eixo vertical: seletor, filtro e "Ir a esta semana" são filhos da MESMA linha flex
    expect(row.className).toContain('items-center');
  });

  it('(ajuste e) "Nadie asignado" diz o MOTIVO que mora no pedido: "Lucía Fernández no viene · Enfermedad"', () => {
    const uncovered = ev({ slotId: 'slot-fri', date: '2026-10-23', weekday: 5, status: 'uncovered', workerId: null, workerDisplayName: null, absenceId: 'ab-2', requestId: 'rq-1' });
    useOccurrences.mockReturnValue(occurrences({ events: [uncovered] }));
    useRequests.mockReturnValue({ requests: [{ requestId: 'rq-1', reasonCode: 'SICK' }], status: 'ok', refresh: vi.fn() });
    renderScreen();
    expect(useRequests).toHaveBeenCalledWith('p-1', 'svc-1', 'upcoming', 3);
    expect(screen.getByTestId('itinerario-proximo-sem-cobertura-slot-fri-2026-10-23')).toHaveTextContent('Lucía Fernández no viene · Enfermedad');
  });

  it('(ajuste e) motivo desconhecido (pedido sem motivo no catálogo ativo, ou turno sem pedido) → só "no viene", nunca o código cru', () => {
    const uncovered = ev({ slotId: 'slot-fri', date: '2026-10-23', weekday: 5, status: 'uncovered', workerId: null, workerDisplayName: null, absenceId: 'ab-2', requestId: 'rq-9' });
    useOccurrences.mockReturnValue(occurrences({ events: [uncovered] }));
    useRequests.mockReturnValue({ requests: [{ requestId: 'rq-9', reasonCode: 'RETIRED_CODE' }], status: 'ok', refresh: vi.fn() });
    const { container } = renderScreen();
    const cell = screen.getByTestId('itinerario-proximo-sem-cobertura-slot-fri-2026-10-23');
    expect(cell).toHaveTextContent('Lucía Fernández no viene');
    expect(cell).not.toHaveTextContent('·');
    expect(container).not.toHaveTextContent('RETIRED_CODE');
  });

  it('filtro por prestador (N7): opções = pessoas da semana, sem repetir; filtra por titular, substituto ou quem atende', () => {
    renderScreen();
    const select = screen.getByTestId('itinerario-filtro-prestador');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Todos', 'Lucía Fernández', 'Martín Gómez']);

    fireEvent.change(select, { target: { value: 'w-martin' } });
    expect(screen.getAllByTestId(/^itinerario-proximo-slot-/)).toHaveLength(1);
    expect(screen.getByTestId('itinerario-proximo-slot-wed-2026-10-21')).toBeInTheDocument();

    // a Lucía é titular do turno coberto E do turno substituído E da ausência sem cobertura
    fireEvent.change(select, { target: { value: 'w-lucia' } });
    expect(screen.getAllByTestId(/^itinerario-proximo-slot-/)).toHaveLength(3);

    fireEvent.change(select, { target: { value: '' } });
    expect(screen.getAllByTestId(/^itinerario-proximo-slot-/)).toHaveLength(3);
  });

  it('trocar de semana zera o filtro (o prestador escolhido pode nem existir na outra semana)', () => {
    renderScreen();
    fireEvent.change(screen.getByTestId('itinerario-filtro-prestador'), { target: { value: 'w-martin' } });
    fireEvent.click(screen.getByTestId('itinerario-semana-seguinte'));
    expect(screen.getByTestId('itinerario-filtro-prestador')).toHaveValue('');
  });

  it('nomes ausentes (sem a célula) viram o rótulo "Prestador sin nombre · …" no filtro', () => {
    useOccurrences.mockReturnValue(occurrences({ events: [ev({ titularDisplayName: null, workerDisplayName: null, titularWorkerId: 'worker-0000-bbbb2222', workerId: 'worker-0000-bbbb2222' })] }));
    renderScreen();
    expect(within(screen.getByTestId('itinerario-filtro-prestador')).getByText('Prestador sin nombre · bbbb2222')).toBeInTheDocument();
  });

  it.each(['idle', 'loading'] as const)('status %s → "Cargando…", sem tabela e sem opções no filtro', (status) => {
    useOccurrences.mockReturnValue(occurrences({ events: null, status }));
    renderScreen();
    expect(screen.getByTestId('itinerario-proximos-carregando')).toHaveTextContent('Cargando los turnos de la semana…');
    expect(screen.queryByTestId('itinerario-proximos-tabela')).toBeNull();
    expect(within(screen.getByTestId('itinerario-filtro-prestador')).getAllByRole('option')).toHaveLength(1);
  });

  it('erro e 403 → alert com mensagem de produto, sem código cru', () => {
    useOccurrences.mockReturnValue(occurrences({ events: null, status: 'error' }));
    const a = renderScreen();
    expect(screen.getByTestId('itinerario-proximos-erro')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('itinerario-proximos-erro')).toHaveTextContent('No se pudieron cargar los turnos de esta semana.');
    a.unmount();
    useOccurrences.mockReturnValue(occurrences({ events: null, status: 'forbidden' }));
    renderScreen();
    expect(screen.getByTestId('itinerario-proximos-erro')).toHaveTextContent('No tenés permiso para ver los turnos de este servicio.');
  });
});

describe('ItineraryServiceScreen — outras abas', () => {
  it('"Horario fijo": a agenda de hoje do serviço; o clique da faixa sobe ao editor (sem mudança de comportamento)', () => {
    const { props } = renderScreen();
    fireEvent.click(screen.getByTestId('itinerario-aba-fixed'));
    expect(screen.getByTestId('itinerario-aba-fixed')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('itinerario-proximos-painel')).toBeNull();
    expect(screen.getByTestId('itinerario-horario-fijo')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-mon'));
    expect(props.onEditSlot).toHaveBeenCalledWith('slot-mon');
  });

  it('"Sustituciones": ponto de montagem da F6 (renderiza o que a aba pai passar)', () => {
    renderScreen({ substitutionsSlot: <p data-testid="slot-f6">conteúdo</p> });
    fireEvent.click(screen.getByTestId('itinerario-aba-substitutions'));
    expect(screen.getByTestId('itinerario-sustituciones-aba')).toContainElement(screen.getByTestId('slot-f6'));
    expect(screen.queryByTestId('itinerario-proximos-painel')).toBeNull();
  });

  it('voltar para "Próximos días" mantém a semana escolhida', () => {
    renderScreen();
    fireEvent.click(screen.getByTestId('itinerario-semana-seguinte'));
    fireEvent.click(screen.getByTestId('itinerario-aba-fixed'));
    fireEvent.click(screen.getByTestId('itinerario-aba-upcoming'));
    expect(screen.getByTestId('itinerario-semana-rotulo')).toHaveTextContent('26 de octubre al 1 de noviembre');
  });
});
