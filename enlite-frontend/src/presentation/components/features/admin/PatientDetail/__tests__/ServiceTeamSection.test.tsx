/**
 * ServiceTeamSection — Quadro C (Fase 10, DX-10.10 (1)). Título vem do DADO DA LINHA (nunca de
 * outra chamada), vazios/erro/forbidden têm testid próprio. `useServiceTeam` (P18) é mockado —
 * este teste cobre só a RENDERIZAÇÃO por estado, não a busca em si (que tem suíte própria).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { ServiceTeamSection } from '../ServiceTeamSection';
import { patientDetailFixture } from './patientDetailFixture';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import type { ServiceTeam } from '@domain/entities/ServiceTeam';
import type { UseServiceTeamResult } from '@hooks/admin/useServiceTeam';

const mockUseServiceTeam = vi.fn<[], UseServiceTeamResult>();
vi.mock('@hooks/admin/useServiceTeam', () => ({
  useServiceTeam: (...args: unknown[]) => mockUseServiceTeam(...(args as [])),
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
  taxCondition: 'IVA_EXEMPT',
  supervisionFrequency: 'DAYS_30',
  guardShift: 'MORNING',
  providerAgeBand: 'AGE_30_45',
  addressId: 'addr-home',
  schedule: null,
  liveVacancyId: null,
  requiredSex: null,
  active: true,
  endedAt: null,
  country: 'AR',
  deviceTypes: ['HOME'],
  providers: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const ADDRESS_HOME = { ...patientDetailFixture.addresses[0], id: 'addr-home', addressFormatted: 'Rua Augusta, 975 - Centro', addressRaw: null };

const TEAM: ServiceTeam = {
  serviceId: 'svc-1',
  vacancyId: 'vac-1',
  asOf: '2026-09-28',
  selected: [{ workerId: 'w1', displayName: 'Ana Fixture', vacancyId: null }],
  inService: [],
  rejected: [],
};

function mockHook(partial: Partial<UseServiceTeamResult>): void {
  mockUseServiceTeam.mockReturnValue({
    team: null,
    status: 'idle',
    reject: vi.fn(),
    revert: vi.fn(),
    substitute: vi.fn(),
    actionError: null,
    refreshError: false,
    ...partial,
  });
}

describe('ServiceTeamSection — vazios, título do dado da linha, erro', () => {
  it('sem seleção (service null): "quadro-c-sem-selecao" e 0 colunas', () => {
    mockHook({ status: 'idle' });
    const { container } = render(
      <ServiceTeamSection patientId="p1" service={null} address={null} selectionNonce={0} />,
    );
    expect(screen.getByTestId('quadro-c-sem-selecao')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid^="kanban-column-"]:not([data-testid$="-count"])').length).toBe(0);
  });

  it('team.vacancyId null: título aparece + "quadro-c-sem-vaga" e 0 colunas', () => {
    mockHook({ status: 'ok', team: { ...TEAM, vacancyId: null } });
    const { container } = render(
      <ServiceTeamSection patientId="p1" service={SERVICE} address={ADDRESS_HOME} selectionNonce={0} />,
    );
    expect(screen.getByTestId('quadro-c-titulo')).toBeTruthy();
    expect(screen.getByTestId('quadro-c-sem-vaga')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid^="kanban-column-"]:not([data-testid$="-count"])').length).toBe(0);
  });

  it('ok: título = "Encuadre Terapéutico: <local>" (rodada 2, decisão A/DIV-6) — o MESMO rótulo careLocationOptions da tabela seletora; e 3 colunas', () => {
    mockHook({ status: 'ok', team: TEAM });
    const { container } = render(
      <ServiceTeamSection patientId="p1" service={SERVICE} address={ADDRESS_HOME} selectionNonce={0} />,
    );
    expect(screen.getByTestId('quadro-c-titulo').textContent).toBe('Encuadre Terapéutico: Domicilio');
    expect(container.querySelectorAll('[data-testid^="kanban-column-"]:not([data-testid$="-count"])').length).toBe(3);
    expectNoRawEnumLeaks(container);
  });

  it('careLocation null + endereço presente: título cai no endereço (fallback)', () => {
    mockHook({ status: 'ok', team: TEAM });
    render(<ServiceTeamSection patientId="p1" service={{ ...SERVICE, careLocation: null }} address={ADDRESS_HOME} selectionNonce={0} />);
    expect(screen.getByTestId('quadro-c-titulo').textContent).toBe(
      'Encuadre Terapéutico: Rua Augusta, 975 - Centro',
    );
  });

  it('careLocation null + sem endereço vinculado: título usa o rótulo "sin dirección"', () => {
    mockHook({ status: 'ok', team: TEAM });
    render(<ServiceTeamSection patientId="p1" service={{ ...SERVICE, careLocation: null }} address={null} selectionNonce={0} />);
    expect(screen.getByTestId('quadro-c-titulo').textContent).toBe('Encuadre Terapéutico: sin dirección');
  });

  it('error: "quadro-c-erro"', () => {
    mockHook({ status: 'error' });
    render(<ServiceTeamSection patientId="p1" service={SERVICE} address={ADDRESS_HOME} selectionNonce={0} />);
    expect(screen.getByTestId('quadro-c-erro')).toBeTruthy();
  });

  it('forbidden: nada (o card inteiro já é ContainerGate)', () => {
    mockHook({ status: 'forbidden' });
    const { container } = render(
      <ServiceTeamSection patientId="p1" service={SERVICE} address={ADDRESS_HOME} selectionNonce={0} />,
    );
    expect(screen.queryByTestId('quadro-c-titulo')).toBeNull();
    expect(screen.queryByTestId('quadro-c-erro')).toBeNull();
    expect(screen.queryByTestId('quadro-c-sem-vaga')).toBeNull();
    expect(container.querySelector('[data-testid="quadro-c-secao"]')?.textContent).toBe('');
  });

  it('actionError: "quadro-c-acao-erro" com o texto do código (repassado ao ServiceTeamBoard)', () => {
    mockHook({ status: 'ok', team: TEAM, actionError: 'SERVICE_TEAM_WORKER_ALLOCATED' });
    render(<ServiceTeamSection patientId="p1" service={SERVICE} address={ADDRESS_HOME} selectionNonce={0} />);
    expect(screen.getByTestId('quadro-c-acao-erro').textContent).toBe(
      'Quitá al prestador del itinerario antes de rechazarlo.',
    );
  });

  it('N3 do gate fecho: refreshError → "quadro-c-refresh-erro" (role=alert, text-red-600) com o texto i18n, e o board continua', () => {
    mockHook({ status: 'ok', team: TEAM, refreshError: true });
    const { container } = render(
      <ServiceTeamSection patientId="p1" service={SERVICE} address={ADDRESS_HOME} selectionNonce={0} />,
    );
    const aviso = screen.getByTestId('quadro-c-refresh-erro');
    expect(aviso.getAttribute('role')).toBe('alert');
    expect(aviso.className).toContain('text-red-600');
    expect(aviso.textContent).toBe(
      'La sustitución se guardó, pero no fue posible actualizar el cuadro. Recargá la página.',
    );
    expect(container.querySelectorAll('[data-testid^="kanban-column-"]:not([data-testid$="-count"])').length).toBe(3);
  });

  it('refreshError false: sem "quadro-c-refresh-erro"', () => {
    mockHook({ status: 'ok', team: TEAM });
    render(<ServiceTeamSection patientId="p1" service={SERVICE} address={ADDRESS_HOME} selectionNonce={0} />);
    expect(screen.queryByTestId('quadro-c-refresh-erro')).toBeNull();
  });

  it('o hook é chamado com o serviceId da linha e o selectionNonce recebido — nunca busca de novo por conta própria', () => {
    mockHook({ status: 'ok', team: TEAM });
    render(<ServiceTeamSection patientId="p9" service={SERVICE} address={ADDRESS_HOME} selectionNonce={7} />);
    expect(mockUseServiceTeam).toHaveBeenCalledWith('p9', 'svc-1', 7);
  });

  it('P32: `onSubstitute` do ServiceTeamBoard é o `substitute` do hook — confirmar o modal chama a função do hook', () => {
    const substitute = vi.fn();
    const teamWithTitular: ServiceTeam = {
      ...TEAM,
      inService: [
        {
          workerId: 'w-titular',
          displayName: 'Fio Fixture',
          vacancyId: 'vac-1',
          allocations: [{ allocationId: 'a1', weekday: 1, startTime: '08:00', endTime: '10:00' }],
        },
      ],
    };
    mockHook({ status: 'ok', team: teamWithTitular, substitute });
    render(<ServiceTeamSection patientId="p1" service={SERVICE} address={ADDRESS_HOME} selectionNonce={0} />);

    fireEvent.click(screen.getByTestId('service-team-substitute-w-titular'));
    const dateSelect = screen.getByTestId('substitution-date') as HTMLSelectElement;
    const firstDate = dateSelect.querySelectorAll('option')[1].getAttribute('value');
    fireEvent.change(dateSelect, { target: { value: firstDate } });
    fireEvent.click(screen.getByTestId('substitution-confirm'));

    expect(substitute).toHaveBeenCalledTimes(1);
    expect(substitute.mock.calls[0][0]).toBe('a1');
    expect(substitute.mock.calls[0][1]).toBe(firstDate);
  });
});
