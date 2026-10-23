/**
 * FixedScheduleTab — "Horario fijo" (mockup B2b): só as linhas dos dias COM atenção (dia · chip · "8 h" · prestador com avatar · ⇄) e
 * "Sin atención: …"; sem o título/"Horas cubiertas"/reserva que o cabeçalho da tela já traz. O comportamento de edição segue (P1).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { PatientItineraryService } from '@domain/entities/PatientItinerary';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { initI18n } from './i18nSetup';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';
import { FixedScheduleTab } from '../FixedScheduleTab';

beforeAll(async () => {
  await initI18n('es');
});

const assignment = (workerId: string, name: string | null, over: Record<string, unknown> = {}) => ({
  workerId, applicationId: 'app', validFrom: '2026-01-01', validTo: null, status: 'ACTIVE' as const, allocationId: `al-${workerId}`, displayName: name, ...over,
});

const SERVICE: PatientItineraryService = {
  contractedServiceId: 'svc-1',
  scheduleHours: 24,
  cobertas: 8,
  reserve: { count: 3, minimum: 10 },
  providersNeeded: null,
  uncoveredShifts: 0,
  slots: [
    { id: 'slot-sun', weekday: 0, startTime: '09:00', endTime: '17:00', durationMinutes: 480, assignments: [assignment('w-lucia', 'Lucía Fernández')] },
    { id: 'slot-mon-b', weekday: 1, startTime: '14:00', endTime: '18:00', durationMinutes: 240, assignments: [assignment('w-x', null), assignment('w-old', 'Ana Ruiz', { validTo: '2026-10-01' })] },
    { id: 'slot-mon-a', weekday: 1, startTime: '09:00', endTime: '13:00', durationMinutes: 240, assignments: [] },
    { id: 'slot-tue', weekday: 2, startTime: '22:00', endTime: '06:00', durationMinutes: 480, assignments: [assignment('w-lucia', 'Lucía Fernández')] },
  ],
};

function renderTab(over: Partial<React.ComponentProps<typeof FixedScheduleTab>> = {}) {
  const props = { service: SERVICE, asOf: '2026-11-02', actionError: null, onEditSlot: vi.fn(), ...over };
  return { ...render(<FixedScheduleTab {...props} />), props };
}

describe('FixedScheduleTab', () => {
  it('(ajuste f) NÃO repete o título do serviço, "Horas cubiertas"/par de horas nem a reserva — isso mora no cabeçalho da tela', () => {
    const { container } = renderTab();
    const tab = screen.getByTestId('itinerario-horario-fijo');
    expect(tab).not.toHaveTextContent('Horas cubiertas');
    expect(tab).not.toHaveTextContent('Equipo de Respuesta Rápida');
    expect(tab).not.toHaveTextContent('Cuidador');
    expect(screen.queryByTestId('itinerario-servico-svc-1')).toBeNull();
    expect(screen.queryByTestId('itinerario-servico-par-svc-1')).toBeNull();
    expect(screen.queryByTestId('itinerario-reserva-svc-1')).toBeNull();
    expectNoRawEnumLeaks(container);
  });

  it('(ajuste f) só as linhas dos dias com atenção, Domingo → Sábado, com o chip, "8 h" e o prestador (nome do avatar); faixas do mesmo dia por horário', () => {
    renderTab();
    const rows = screen.getAllByTestId(/^itinerario-dia-svc-1-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'itinerario-dia-svc-1-0-slot-sun',
      'itinerario-dia-svc-1-1-slot-mon-a',
      'itinerario-dia-svc-1-1-slot-mon-b',
      'itinerario-dia-svc-1-2-slot-tue',
    ]);
    const sunday = rows[0];
    expect(sunday).toHaveTextContent('domingo');
    expect(within(sunday).getByTestId('itinerario-slot-horario-slot-sun')).toHaveTextContent('09:00 – 17:00');
    expect(within(sunday).getByTestId('itinerario-slot-duracao-slot-sun')).toHaveTextContent('8 h');
    expect(within(sunday).getByTestId('itinerario-slot-prestador-slot-sun-w-lucia')).toHaveTextContent('Lucía Fernández');
    expect(within(sunday).getByTestId('person-avatar')).toHaveTextContent('LF');
    // a 2ª faixa da segunda não repete o dia na tela (leitor de tela ainda o lê)
    expect(rows[2].querySelector('.sr-only')).toHaveTextContent('lunes');
  });

  it('faixa noturna diz que termina no dia seguinte; faixa sem prestador vigente mostra "Sin asignar" e segue editável', () => {
    const { props } = renderTab();
    expect(screen.getByTestId('itinerario-dia-svc-1-2-slot-tue')).toHaveTextContent('termina al día siguiente');
    expect(screen.getByTestId('itinerario-dia-svc-1-1-slot-mon-a')).not.toHaveTextContent('termina al día siguiente');
    expect(screen.getByTestId('itinerario-slot-sem-prestador-slot-mon-a')).toHaveTextContent('Sin asignar');
    // alocação fora da vigência (Ana, validTo < asOf) não aparece; a vigente sem nome vira o rótulo de fallback
    expect(screen.queryByTestId('itinerario-slot-prestador-slot-mon-b-w-old')).toBeNull();
    expect(screen.getByTestId('itinerario-slot-prestador-slot-mon-b-w-x')).toHaveTextContent('Prestador sin nombre');
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-mon-a'));
    expect(props.onEditSlot).toHaveBeenCalledWith('slot-mon-a');
  });

  it('(ajuste f) "Sin atención: miércoles, jueves, viernes y sábado" lista os dias SEM faixa; com os 7 dias ocupados a linha some', () => {
    const { rerender, props } = renderTab();
    expect(screen.getByTestId('itinerario-sin-atencion')).toHaveTextContent('Sin atención: miércoles, jueves, viernes y sábado');
    const full = { ...SERVICE, slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ id: `s${weekday}`, weekday, startTime: '09:00', endTime: '10:00', durationMinutes: 60, assignments: [] })) };
    rerender(<FixedScheduleTab {...props} service={full} />);
    expect(screen.queryByTestId('itinerario-sin-atencion')).toBeNull();
    const one = { ...SERVICE, slots: SERVICE.slots.slice(0, 1) };
    rerender(<FixedScheduleTab {...props} service={one} />);
    expect(screen.getByTestId('itinerario-sin-atencion')).toHaveTextContent('Sin atención: lunes, martes, miércoles, jueves, viernes y sábado');
    const sixDays = { ...SERVICE, slots: [0, 1, 2, 3, 4, 5].map((weekday) => ({ id: `s${weekday}`, weekday, startTime: '09:00', endTime: '10:00', durationMinutes: 60, assignments: [] })) };
    rerender(<FixedScheduleTab {...props} service={sixDays} />);
    expect(screen.getByTestId('itinerario-sin-atencion')).toHaveTextContent('Sin atención: sábado');
  });

  it('sem nenhuma faixa: nenhuma linha e TODOS os dias em "Sin atención"', () => {
    renderTab({ service: { ...SERVICE, slots: [] } });
    expect(screen.queryAllByTestId(/^itinerario-dia-svc-1-/)).toHaveLength(0);
    expect(screen.getByTestId('itinerario-sin-atencion')).toHaveTextContent('domingo, lunes, martes, miércoles, jueves, viernes y sábado');
  });

  it('a recusa da última ação continua aparecendo: sobreposição com os 2 horários e a folga; outro código pela tradução; sem erro, nada', () => {
    const overlap = { existing: { serviceId: 's', weekday: 1, startTime: '09:00', endTime: '13:00' }, requested: { serviceId: 's', weekday: 1, startTime: '12:00', endTime: '14:00' }, sameAddress: false, minGapMinutes: 60 };
    const a = renderTab({ actionError: { code: 'ITINERARY_OVERLAP', overlap } });
    expect(screen.getByTestId('itinerario-sobreposicao-erro')).toHaveTextContent('lunes 09:00-13:00');
    expect(screen.getByTestId('itinerario-sobreposicao-erro')).toHaveTextContent('lunes 12:00-14:00');
    expect(screen.getByTestId('itinerario-sobreposicao-erro')).toHaveTextContent('60');
    a.unmount();
    const b = renderTab({ actionError: { code: 'ITINERARY_OVERLAP', overlap: { ...overlap, minGapMinutes: null } } });
    expect(screen.getByTestId('itinerario-sobreposicao-erro')).not.toHaveTextContent('60');
    b.unmount();
    const c = renderTab({ actionError: { code: 'SLOT_INACTIVE' } });
    expect(screen.getByTestId('itinerario-acao-erro')).toHaveTextContent('Esta franja ya no está activa.');
    c.unmount();
    renderTab({ actionError: { code: 'CODIGO_NOVO_SEM_TRADUCAO' } });
    expect(screen.getByTestId('itinerario-acao-erro')).toHaveTextContent('No se pudo asignar el prestador.');
    expect(screen.getByTestId('itinerario-acao-erro')).not.toHaveTextContent('CODIGO_NOVO_SEM_TRADUCAO');
  });

  it('sem a célula patient_itinerary:update a faixa é só de LEITURA: sem ⇄ (nada de editar), o dado segue visível', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['patient_services:read'], countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
    });
    renderTab();
    expect(screen.queryByTestId('itinerario-slot-editar-slot-sun')).toBeNull();
    expect(screen.getByTestId('itinerario-slot-somente-leitura-slot-sun')).toBeInTheDocument();
    expect(screen.getByTestId('itinerario-slot-prestador-slot-sun-w-lucia')).toHaveTextContent('Lucía Fernández');
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('pt-BR: "Sem atendimento: …" com a conjunção do idioma', async () => {
    await initI18n('pt-BR');
    const view = renderTab();
    expect(screen.getByTestId('itinerario-sin-atencion')).toHaveTextContent(/^Sem atendimento: quarta-feira, quinta-feira, sexta-feira e sábado$/);
    expect(screen.getByTestId('itinerario-slot-editar-slot-sun')).toHaveAttribute('aria-label', 'Trocar prestador');
    view.unmount();
    await initI18n('es');
  });
});
