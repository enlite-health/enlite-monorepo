/**
 * ItineraryDayCard — D445.3 (nó Figma 11340:76163). O card de um dia da agenda: expansível/
 * colapsável (aberto por padrão quando há faixa ativa), o chip de horário em DUAS linhas, o
 * endereço do serviço, quem cobre em `asOf` (ou "Sin asignar"), e a linha inteira clicável abre
 * "Editar agendamiento" — gateado por `patient_itinerary:update` (D269: sem a célula, SOME o
 * clique/swap, o dado continua visível). i18n real (es).
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
const ADDRESS = 'Rua Augusta, 975 - São Paulo/SP';

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

function renderCard(slots: PatientItinerarySlot[], onEditSlot = vi.fn()) {
  const utils = render(<ItineraryDayCard serviceId="svc-1" weekday={1} slots={slots} asOf={ASOF} addressLabel={ADDRESS} onEditSlot={onEditSlot} />);
  return { ...utils, onEditSlot };
}

function comEnforcement(permissions: string[]) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement: 'on',
    } as AuthzContract,
  });
}

describe('ItineraryDayCard — o card de um dia da agenda (D445.3)', () => {
  it('dia sem slot → testid de vazio e o texto "Sin atención", com o nome do dia, sem toggle', () => {
    const { container } = renderCard([]);
    expect(screen.getByTestId('itinerario-dia-vazio-svc-1-1')).toHaveTextContent('Sin atención');
    expect(screen.getByTestId('itinerario-dia-svc-1-1')).toHaveTextContent('lunes');
    expect(screen.queryByTestId('itinerario-dia-toggle-svc-1-1')?.querySelector('svg')).toBeNull();
    expectNoRawEnumLeaks(container);
  });

  it('Figma: badge | endereço | prestador | ⇄ na MESMA linha (sem quebra de linha)', () => {
    renderCard([slot({ assignments: [assignment()] })]);
    const row = screen.getByTestId('itinerario-slot-editar-slot-1');
    expect(row.className).not.toContain('flex-wrap');
    expect(row).toContainElement(screen.getByTestId('itinerario-slot-horario-slot-1'));
    expect(row).toContainElement(screen.getByTestId('itinerario-slot-prestador-slot-1-worker-0000-aaaa1111'));
    expect(row).toHaveTextContent(ADDRESS);
  });

  it('slot ativo sem vigente → chip com as DUAS linhas (início/fim) e "Sin asignar"; clicar chama onEditSlot', () => {
    const { onEditSlot } = renderCard([slot()]);
    const horario = screen.getByTestId('itinerario-slot-horario-slot-1');
    expect(horario).toHaveTextContent('08:00');
    expect(horario).toHaveTextContent('12:00');
    expect(screen.getByTestId('itinerario-slot-sem-prestador-slot-1')).toHaveTextContent('Sin asignar');
    expect(screen.queryByTestId('itinerario-dia-vazio-svc-1-1')).toBeNull();
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
    expect(onEditSlot).toHaveBeenCalledTimes(1);
    expect(onEditSlot).toHaveBeenCalledWith('slot-1');
  });

  it('slot com vigente → o nome, o endereço, e clicar chama onEditSlot também', () => {
    const { onEditSlot } = renderCard([slot({ assignments: [assignment()] })]);
    expect(screen.getByTestId('itinerario-slot-prestador-slot-1-worker-0000-aaaa1111')).toHaveTextContent('Ana Fixture');
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
    expect(onEditSlot).toHaveBeenCalledWith('slot-1');
  });

  it('vigente sem nome (sem a célula) → "Prestador sin nombre · <8 últimos>"', () => {
    renderCard([slot({ assignments: [assignment({ displayName: null })] })]);
    expect(screen.getByTestId('itinerario-slot-prestador-slot-1-worker-0000-aaaa1111')).toHaveTextContent(
      'Prestador sin nombre · aaaa1111',
    );
  });

  it('alocação ENDED não cobre → "Sin asignar"', () => {
    renderCard([slot({ assignments: [assignment({ status: 'ENDED', validTo: '2026-09-20' })] })]);
    expect(screen.queryByTestId('itinerario-slot-prestador-slot-1-worker-0000-aaaa1111')).toBeNull();
    expect(screen.getByTestId('itinerario-slot-sem-prestador-slot-1')).toBeInTheDocument();
  });

  it('alocação que só começa depois de asOf não cobre', () => {
    renderCard([slot({ assignments: [assignment({ validFrom: '2026-09-29' })] })]);
    expect(screen.getByTestId('itinerario-slot-sem-prestador-slot-1')).toBeInTheDocument();
  });

  it('slot active: false não aparece — o dia vira vazio', () => {
    renderCard([slot({ active: false })]);
    expect(screen.queryByTestId('itinerario-slot-horario-slot-1')).toBeNull();
    expect(screen.getByTestId('itinerario-dia-vazio-svc-1-1')).toBeInTheDocument();
  });

  it('toggle colapsa e esconde as faixas', () => {
    renderCard([slot()]);
    expect(screen.getByTestId('itinerario-slot-editar-slot-1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('itinerario-dia-toggle-svc-1-1'));
    expect(screen.queryByTestId('itinerario-slot-editar-slot-1')).toBeNull();
    fireEvent.click(screen.getByTestId('itinerario-dia-toggle-svc-1-1'));
    expect(screen.getByTestId('itinerario-slot-editar-slot-1')).toBeInTheDocument();
  });

  it('enforcement on SEM patient_itinerary:update → a faixa fica SÓ LEITURA (sem clique/swap), mas o dado continua visível', () => {
    comEnforcement(['patient_services:read']);
    renderCard([slot({ assignments: [assignment()] })]);
    expect(screen.queryByTestId('itinerario-slot-editar-slot-1')).toBeNull();
    const readOnly = screen.getByTestId('itinerario-slot-somente-leitura-slot-1');
    expect(readOnly.tagName).toBe('DIV');
    expect(readOnly).toHaveTextContent('Ana Fixture');
  });

  it('enforcement on COM patient_itinerary:update → a faixa é clicável', () => {
    comEnforcement(['patient_services:read', 'patient_itinerary:update']);
    renderCard([slot()]);
    expect(screen.getByTestId('itinerario-slot-editar-slot-1').tagName).toBe('BUTTON');
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
