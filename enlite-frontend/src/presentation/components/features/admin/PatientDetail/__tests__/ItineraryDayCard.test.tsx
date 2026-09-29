/**
 * ItineraryDayCard — Fase 12, DX-12.7/12.10/12.11. O card de um dia da agenda: vazio com testid
 * próprio, chip do horário, quem cobre em `asOf` e "Asignar prestador" só no slot sem vigente
 * (gateado por `patient_itinerary:update` quando o engine está ligado). i18n real (es).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { PatientItineraryAssignment, PatientItinerarySlot } from '@domain/entities/PatientItinerary';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { ItineraryDayCard } from '../ItineraryDayCard';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

beforeEach(() => {
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
});

const ASOF = '2026-09-28';

function assignment(over: Partial<PatientItineraryAssignment> = {}): PatientItineraryAssignment {
  return {
    workerId: 'worker-0000-aaaa1111',
    applicationId: 'app-1',
    validFrom: '2026-09-01',
    validTo: null,
    status: 'ACTIVE',
    allocationId: 'alloc-1',
    displayName: 'Ana Fixture',
    ...over,
  };
}

function slot(over: Partial<PatientItinerarySlot> = {}): PatientItinerarySlot {
  return { id: 'slot-1', weekday: 1, startTime: '08:00', endTime: '12:00', active: true, assignments: [], ...over };
}

function renderCard(slots: PatientItinerarySlot[], onAssign = vi.fn()) {
  const utils = render(<ItineraryDayCard serviceId="svc-1" weekday={1} slots={slots} asOf={ASOF} onAssign={onAssign} />);
  return { ...utils, onAssign };
}

function comEnforcement(permissions: string[]) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement: 'on',
    } as AuthzContract,
  });
}

describe('ItineraryDayCard — o card de um dia da agenda', () => {
  it('dia sem slot → testid de vazio e o texto "Sin atención", com o nome do dia', () => {
    const { container } = renderCard([]);
    expect(screen.getByTestId('itinerario-dia-vazio-svc-1-1')).toHaveTextContent('Sin atención');
    expect(screen.getByTestId('itinerario-dia-svc-1-1')).toHaveTextContent('lunes');
    expect(screen.queryByTestId('itinerario-slot-asignar-slot-1')).toBeNull();
    expectNoRawEnumLeaks(container);
  });

  it('slot ativo sem vigente → chip "HH:MM - HH:MM" e "Asignar prestador" (engine OFF → visível)', () => {
    const { onAssign } = renderCard([slot()]);
    expect(screen.getByTestId('itinerario-slot-horario-slot-1')).toHaveTextContent('08:00 - 12:00');
    const btn = screen.getByTestId('itinerario-slot-asignar-slot-1');
    expect(btn).toHaveTextContent('Asignar prestador');
    expect(screen.queryByTestId('itinerario-dia-vazio-svc-1-1')).toBeNull();
    fireEvent.click(btn);
    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith('slot-1');
  });

  it('slot com vigente → o nome e SEM o botão', () => {
    renderCard([slot({ assignments: [assignment()] })]);
    expect(screen.getByTestId('itinerario-slot-prestador-slot-1-worker-0000-aaaa1111')).toHaveTextContent('Ana Fixture');
    expect(screen.queryByTestId('itinerario-slot-asignar-slot-1')).toBeNull();
  });

  it('vigente sem nome (sem a célula) → "Prestador sin nombre · <8 últimos>"', () => {
    renderCard([slot({ assignments: [assignment({ displayName: null })] })]);
    expect(screen.getByTestId('itinerario-slot-prestador-slot-1-worker-0000-aaaa1111')).toHaveTextContent(
      'Prestador sin nombre · aaaa1111',
    );
  });

  it('alocação ENDED não cobre → o botão aparece e o nome não', () => {
    renderCard([slot({ assignments: [assignment({ status: 'ENDED', validTo: '2026-09-20' })] })]);
    expect(screen.queryByTestId('itinerario-slot-prestador-slot-1-worker-0000-aaaa1111')).toBeNull();
    expect(screen.getByTestId('itinerario-slot-asignar-slot-1')).toBeInTheDocument();
  });

  it('alocação que só começa depois de asOf não cobre', () => {
    renderCard([slot({ assignments: [assignment({ validFrom: '2026-09-29' })] })]);
    expect(screen.getByTestId('itinerario-slot-asignar-slot-1')).toBeInTheDocument();
  });

  it('slot active: false não aparece — o dia vira vazio', () => {
    renderCard([slot({ active: false })]);
    expect(screen.queryByTestId('itinerario-slot-horario-slot-1')).toBeNull();
    expect(screen.getByTestId('itinerario-dia-vazio-svc-1-1')).toBeInTheDocument();
  });

  it('enforcement on SEM patient_itinerary:update → o botão some (0)', () => {
    comEnforcement(['patient_services:read']);
    renderCard([slot()]);
    expect(screen.queryAllByTestId('itinerario-slot-asignar-slot-1')).toHaveLength(0);
  });

  it('enforcement on COM patient_itinerary:update → o botão aparece (1)', () => {
    comEnforcement(['patient_services:read', 'patient_itinerary:update']);
    renderCard([slot()]);
    expect(screen.queryAllByTestId('itinerario-slot-asignar-slot-1')).toHaveLength(1);
  });

  it('o card vem de organisms/Card (rounded-2xl do átomo) e nenhuma classe tem cor literal', () => {
    const { container } = renderCard([slot(), slot({ id: 'slot-2', startTime: '14:00', endTime: '18:00', assignments: [assignment()] })]);
    const wrapper = container.querySelector('[data-testid^="itinerario-dia-"]');
    expect(wrapper).not.toBeNull();
    const card = wrapper?.firstElementChild as HTMLElement;
    expect(card.className).toContain('rounded-2xl');
    expect(card.className).toContain('border-gray-600');
    const classes = Array.from(container.querySelectorAll('[class]')).map((el) => el.getAttribute('class') ?? '');
    expect(classes.length).toBeGreaterThan(3);
    expect(classes.filter((c) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(c))).toEqual([]);
  });

  it('pt-BR → nome do dia em português', async () => {
    await i18n.changeLanguage('pt-BR');
    const { unmount } = renderCard([]);
    try {
      expect(screen.getByTestId('itinerario-dia-svc-1-1')).toHaveTextContent('segunda-feira');
      expect(screen.getByTestId('itinerario-dia-vazio-svc-1-1')).toHaveTextContent('Sem atendimento');
    } finally {
      unmount();
      await i18n.changeLanguage('es');
    }
  });
});
