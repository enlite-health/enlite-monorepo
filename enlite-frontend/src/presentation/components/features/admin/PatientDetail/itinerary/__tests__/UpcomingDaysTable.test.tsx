/**
 * UpcomingDaysTable — spec 069, US2/FR-12: Día · Horario · Quién atiende · Acción, uma linha por turno.
 * Titular · Sustitución (cubre a …) · "Nadie asignado" (ausência sem substituto OU faixa sem alocação).
 * i18n real; ação gateada por `patient_itinerary:update`.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import { initI18n, i18n } from './i18nSetup';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';
import { UpcomingDaysTable } from '../UpcomingDaysTable';
import { occurrenceKey } from '../occurrenceKey';

beforeAll(async () => {
  await initI18n('es');
});

beforeEach(() => {
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
});

function event(over: Partial<PatientItineraryEvent> = {}): PatientItineraryEvent {
  return {
    date: '2026-11-02',
    weekday: 1,
    serviceId: 'svc-1',
    slotId: 'slot-mon',
    assignmentId: 'a-1',
    startTime: '09:00',
    endTime: '17:00',
    titularWorkerId: 'w-lucia',
    titularDisplayName: 'Lucía Fernández',
    status: 'covered',
    workerId: 'w-lucia',
    workerDisplayName: 'Lucía Fernández',
    substituteWorkerId: null,
    substituteDisplayName: null,
    absenceId: null,
    requestId: null,
    ...over,
  };
}

const COVERED = event();
const NIGHT_UNCOVERED = event({
  date: '2026-11-03', weekday: 2, slotId: 'slot-tue', startTime: '22:00', endTime: '06:00', status: 'uncovered',
  workerId: null, workerDisplayName: null, absenceId: 'abs-1', requestId: 'r-1',
});
const SUBSTITUTED = event({
  date: '2026-11-08', weekday: 0, slotId: 'slot-sun', status: 'substituted', workerId: 'w-martin', workerDisplayName: 'Martín Gómez',
  substituteWorkerId: 'w-martin', substituteDisplayName: 'Martín Gómez', absenceId: 'abs-2', requestId: 'r-2',
});
const NO_ALLOCATION = event({
  date: '2026-11-04', weekday: 3, slotId: 'slot-wed', assignmentId: null, titularWorkerId: null, titularDisplayName: null,
  status: 'uncovered', workerId: null, workerDisplayName: null,
});

function renderTable(events: PatientItineraryEvent[], handlers = { onChange: vi.fn(), onAssign: vi.fn() }) {
  const utils = render(<UpcomingDaysTable events={events} {...handlers} />);
  return { ...utils, ...handlers };
}

describe('UpcomingDaysTable', () => {
  it('cabeçalho Día · Horario · Quién atiende · Acción e uma linha por turno, em ordem de data (mockup b2a)', () => {
    const { container } = renderTable([SUBSTITUTED, NIGHT_UNCOVERED, COVERED]);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Día', 'Horario', 'Quién atiende', 'Acción']);
    const rows = screen.getAllByTestId(/^itinerario-proximo-slot-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'itinerario-proximo-slot-mon-2026-11-02',
      'itinerario-proximo-slot-tue-2026-11-03',
      'itinerario-proximo-slot-sun-2026-11-08',
    ]);
    expect(rows.every((r) => r.className.includes('h-[76px]'))).toBe(true); // linhas de mesma altura
    expectNoRawEnumLeaks(container);
  });

  it('turno coberto: dia por extenso, chip de horário, "8 h", titular com "Titular" e botão Cambiar', () => {
    const { onChange } = renderTable([COVERED]);
    const row = screen.getByTestId('itinerario-proximo-slot-mon-2026-11-02');
    expect(row).toHaveTextContent('lunes');
    expect(row).toHaveTextContent('2 de noviembre');
    expect(screen.getByTestId('itinerario-proximo-horario-slot-mon-2026-11-02')).toHaveTextContent('09:00 – 17:00');
    expect(row).toHaveTextContent('8 h');
    expect(row).not.toHaveTextContent('termina');
    expect(row).toHaveTextContent('Lucía Fernández');
    expect(row).toHaveTextContent('Titular');
    fireEvent.click(within(row).getByRole('button', { name: /Cambiar/ }));
    expect(onChange).toHaveBeenCalledWith(COVERED);
  });

  it('turno noturno: "8 h · termina el miércoles 4" (data de início manda, FR-13)', () => {
    renderTable([NIGHT_UNCOVERED]);
    const row = screen.getByTestId('itinerario-proximo-slot-tue-2026-11-03');
    expect(row).toHaveTextContent('22:00 – 06:00');
    expect(row).toHaveTextContent('8 h · termina el miércoles 4');
  });

  it('sin cubrir por AUSÊNCIA: "Nadie asignado" em vermelho, "<titular> no viene" e Asignar (nunca Cambiar)', () => {
    const { onAssign } = renderTable([NIGHT_UNCOVERED]);
    const sem = screen.getByTestId('itinerario-proximo-sem-cobertura-slot-tue-2026-11-03');
    expect(sem).toHaveTextContent('Nadie asignado');
    expect(sem).toHaveTextContent('Lucía Fernández no viene');
    expect(within(sem).getByText('Nadie asignado').className).toContain('text-red-800');
    expect(screen.queryByRole('button', { name: /Cambiar/ })).toBeNull();
    fireEvent.click(screen.getByTestId('itinerario-proximo-asignar-slot-tue-2026-11-03'));
    expect(onAssign).toHaveBeenCalledWith(NIGHT_UNCOVERED);
  });

  it('sin cubrir por FAIXA SEM ALOCAÇÃO (assignmentId null): o turno aparece, "Franja sin prestador", Asignar', () => {
    const { onAssign } = renderTable([NO_ALLOCATION]);
    const sem = screen.getByTestId('itinerario-proximo-sem-cobertura-slot-wed-2026-11-04');
    expect(sem).toHaveTextContent('Nadie asignado');
    expect(sem).toHaveTextContent('Franja sin prestador');
    fireEvent.click(screen.getByTestId('itinerario-proximo-asignar-slot-wed-2026-11-04'));
    expect(onAssign).toHaveBeenCalledWith(NO_ALLOCATION);
  });

  it('substituído: nome de quem cobre + selo "Sustitución" + "Cubre a <titular>" + Cambiar', () => {
    const { onChange } = renderTable([SUBSTITUTED]);
    const row = screen.getByTestId('itinerario-proximo-slot-sun-2026-11-08');
    expect(row).toHaveTextContent('Martín Gómez');
    expect(row).toHaveTextContent('Sustitución');
    expect(row).toHaveTextContent('Cubre a Lucía Fernández');
    fireEvent.click(within(row).getByRole('button', { name: /Cambiar/ }));
    expect(onChange).toHaveBeenCalledWith(SUBSTITUTED);
  });

  it('substituído sem titular conhecido: "Cubre a sin titular" (nunca quebra)', () => {
    renderTable([{ ...SUBSTITUTED, titularWorkerId: null, titularDisplayName: null }]);
    expect(screen.getByTestId('itinerario-proximo-slot-sun-2026-11-08')).toHaveTextContent('Cubre a sin titular');
  });

  it('nome ausente (sem a célula): cai no rótulo "Prestador sin nombre · <8 últimos do id>", nunca em branco', () => {
    renderTable([event({ workerDisplayName: null, workerId: 'worker-0000-aaaa1111' })]);
    expect(screen.getByTestId('itinerario-proximo-slot-mon-2026-11-02')).toHaveTextContent('Prestador sin nombre · aaaa1111');
  });

  it('defesa: "covered" SEM prestador resolvido não inventa nome — cai em "Nadie asignado"', () => {
    renderTable([event({ workerId: null, workerDisplayName: null })]);
    expect(screen.getByTestId('itinerario-proximo-sem-cobertura-slot-mon-2026-11-02')).toHaveTextContent('Nadie asignado');
  });

  it('desempate da ordem: mesma data → pelo início; mesmo início → pela faixa (ordem estável entre renders)', () => {
    const tarde = event({ slotId: 'slot-b', startTime: '14:00', endTime: '18:00' });
    const manhaB = event({ slotId: 'slot-b2', startTime: '08:00', endTime: '12:00' });
    const manhaA = event({ slotId: 'slot-a2', startTime: '08:00', endTime: '12:00' });
    renderTable([tarde, manhaB, manhaA]);
    expect(screen.getAllByTestId(/^itinerario-proximo-slot-/).map((r) => r.getAttribute('data-testid'))).toEqual([
      'itinerario-proximo-slot-a2-2026-11-02',
      'itinerario-proximo-slot-b2-2026-11-02',
      'itinerario-proximo-slot-b-2026-11-02',
    ]);
  });

  it('chave/testid do turno é slotId + data (assignmentId pode ser null)', () => {
    expect(occurrenceKey(NO_ALLOCATION)).toBe('slot-wed-2026-11-04');
  });

  it('semana sem turnos: estado vazio, sem tabela', () => {
    renderTable([]);
    expect(screen.getByTestId('itinerario-proximos-vazio')).toHaveTextContent('No hay turnos en esta semana.');
    expect(screen.queryByTestId('itinerario-proximos-tabela')).toBeNull();
  });

  it('sem a célula patient_itinerary:update (enforcement on): as ações SOMEM, o dado continua', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['patient_services:read'], countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
    });
    renderTable([COVERED, NIGHT_UNCOVERED]);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTestId('itinerario-proximo-slot-mon-2026-11-02')).toHaveTextContent('Lucía Fernández');
  });

  it('pt-BR: cabeçalho e textos no idioma ativo', async () => {
    await act(async () => {
      await i18n.changeLanguage('pt-BR');
    });
    renderTable([NIGHT_UNCOVERED]);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Dia', 'Horário', 'Quem atende', 'Ação']);
    expect(screen.getByTestId('itinerario-proximo-slot-tue-2026-11-03')).toHaveTextContent('Ninguém escalado');
    expect(screen.getByTestId('itinerario-proximo-slot-tue-2026-11-03')).toHaveTextContent('termina quarta-feira 4');
    await act(async () => {
      await i18n.changeLanguage('es');
    });
  });
});
