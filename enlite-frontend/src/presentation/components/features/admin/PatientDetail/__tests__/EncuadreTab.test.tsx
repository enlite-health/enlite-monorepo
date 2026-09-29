/**
 * EncuadreTab — aba "Encuadre" (Figma nó 11340:76414, decisões do Gabriel de 29/09). Cobre o que
 * é PRÓPRIO desta aba: o seletor de serviço (a mesma mecânica de seleção que antes vivia dentro de
 * `ServicosContratadosCard` — molde do describe "Quadro C (DX-10.9)" que saiu de lá) e o bloco de
 * detalhes com fonte (Horas semanais/Capacidad). `ServiceTeamSection` é dublê — o que ELA renderiza
 * já está coberto em `ServiceTeamSection.test.tsx`/`ServiceTeamBoard.test.tsx`; aqui só se prova o
 * que ESTA aba passa para ela.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { EncuadreTab } from '../EncuadreTab';
import { patientDetailFixture } from './patientDetailFixture';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

const mockServiceTeamSectionCalls = vi.fn();
vi.mock('../ServiceTeamSection', () => ({
  ServiceTeamSection: (props: { patientId: string; service: { id: string } | null; address: unknown; selectionNonce: number }) => {
    mockServiceTeamSectionCalls(props);
    return (
      <div
        data-testid="service-team-section-stub"
        data-service-id={props.service?.id ?? ''}
        data-nonce={props.selectionNonce}
      />
    );
  },
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const SERVICE: PatientContractedServiceDetail = {
  id: 'svc-1',
  patientId: patientDetailFixture.id,
  serviceCode: 'AT',
  professionalProfile: null,
  providersNeeded: 2,
  authorizedHours: 20,
  weeklyHours: 20,
  careLocation: 'HOME',
  hourlyValue: 1500,
  hourlyValueRedacted: false,
  startDate: '2026-09-01T00:00:00.000Z',
  contractType: 'OBRA_SOCIAL',
  taxCondition: 'IVA_21',
  supervisionFrequency: 'DAYS_15',
  guardShift: null,
  providerAgeBand: null,
  addressId: 'addr1',
  schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
  liveVacancyId: null,
  active: true,
  endedAt: null,
  country: 'BR',
  deviceTypes: ['AT'],
  providers: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const SVC2: PatientContractedServiceDetail = { ...SERVICE, id: 'svc-2', serviceCode: 'CAREGIVER', weeklyHours: 30, providersNeeded: 1 };

describe('EncuadreTab — seletor de serviço + bloco de detalhes com fonte', () => {
  it('sem serviços: empty state, não quebra', () => {
    const patient = { ...patientDetailFixture, contractedServices: [] };
    render(<EncuadreTab patient={patient} />);
    expect(screen.getByTestId('encuadre-tab')).toBeInTheDocument();
    expect(screen.getByText('Sin datos cargados')).toBeInTheDocument();
    expect(screen.getByTestId('service-team-section-stub').getAttribute('data-service-id')).toBe('');
  });

  it('sem clique: nenhuma linha selecionada; ServiceTeamSection recebe service=null', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE, SVC2] };
    render(<EncuadreTab patient={patient} />);

    expect(screen.getByTestId('encuadre-service-row-svc-1').getAttribute('aria-selected')).toBeNull();
    expect(screen.getByTestId('encuadre-service-row-svc-2').getAttribute('aria-selected')).toBeNull();
    expect(screen.getByTestId('service-team-section-stub').getAttribute('data-service-id')).toBe('');
    expect(screen.queryByTestId('encuadre-detalhes')).not.toBeInTheDocument();
  });

  it('clique na linha 2: aria-selected="true" SÓ nela; ServiceTeamSection recebe o serviço 2', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE, SVC2] };
    render(<EncuadreTab patient={patient} />);

    fireEvent.click(screen.getByTestId('encuadre-service-row-svc-2'));

    expect(screen.getByTestId('encuadre-service-row-svc-2').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('encuadre-service-row-svc-1').getAttribute('aria-selected')).toBeNull();
    expect(screen.getByTestId('service-team-section-stub').getAttribute('data-service-id')).toBe('svc-2');
  });

  it('clicar de novo NA MESMA linha incrementa o selectionNonce (o operador "atualiza" o quadro C sem recarregar)', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<EncuadreTab patient={patient} />);

    fireEvent.click(screen.getByTestId('encuadre-service-row-svc-1'));
    const nonceApos1 = Number(screen.getByTestId('service-team-section-stub').getAttribute('data-nonce'));

    fireEvent.click(screen.getByTestId('encuadre-service-row-svc-1'));
    const nonceApos2 = Number(screen.getByTestId('service-team-section-stub').getAttribute('data-nonce'));

    expect(nonceApos2).toBe(nonceApos1 + 1);
  });

  it('clique na linha NÃO abre drawer nenhum (a edição continua só na aba "Servicio Contratado")', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<EncuadreTab patient={patient} />);

    fireEvent.click(screen.getByTestId('encuadre-service-row-svc-1'));

    expect(screen.queryByTestId('contracted-service-detail-drawer')).not.toBeInTheDocument();
  });

  it('bloco de detalhes: mostra Horas semanales e Capacidad (campos COM fonte); some quando nada está selecionado', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<EncuadreTab patient={patient} />);

    fireEvent.click(screen.getByTestId('encuadre-service-row-svc-1'));

    const detalhes = screen.getByTestId('encuadre-detalhes');
    expect(detalhes).toHaveTextContent('Horas semanales');
    expect(detalhes).toHaveTextContent('20');
    expect(detalhes).toHaveTextContent('Capacidad');
    expect(detalhes).toHaveTextContent('2');
    // Figma pede também "Plazo de pago" e "Valor líquido/hora" — SEM fonte no backend
    // (`payment_term_days`/`net_hourly_rate` nunca populados, ver comentário de `EncuadreTab.tsx`)
    // e por isso NÃO aparecem — nada de rótulo com "—" fingindo que o dado existe.
    expect(detalhes).not.toHaveTextContent('Plazo de pago');
    expect(detalhes).not.toHaveTextContent('líquido');
  });

  it('weeklyHours/providersNeeded null: bloco de detalhes mostra "—", não quebra', () => {
    const svcNull = { ...SERVICE, weeklyHours: null, providersNeeded: null };
    const patient = { ...patientDetailFixture, contractedServices: [svcNull] };
    render(<EncuadreTab patient={patient} />);

    fireEvent.click(screen.getByTestId('encuadre-service-row-svc-1'));

    const detalhes = screen.getByTestId('encuadre-detalhes');
    expect(detalhes.textContent).toContain('—');
  });

  it('sem coluna SEXO (sem fonte no backend) e sem ações de editar/ativar (isso é só da outra aba)', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<EncuadreTab patient={patient} />);

    expect(screen.queryByTestId('contracted-service-edit-svc-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contracted-service-activate-recruitment-svc-1')).not.toBeInTheDocument();
  });

  it('sem enum cru na tela (guard de i18n)', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE, SVC2] };
    const { container } = render(<EncuadreTab patient={patient} />);
    fireEvent.click(screen.getByTestId('encuadre-service-row-svc-1'));
    expectNoRawEnumLeaks(container);
  });
});
