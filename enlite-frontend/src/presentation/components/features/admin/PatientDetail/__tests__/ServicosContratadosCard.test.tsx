/**
 * ServicosContratadosCard — spec 013, bloco C. Reproduz `#PEND-08` ("drawer com 1 campo;
 * dispositivo vazio") ANTES do fix: a versão anterior do card lia só `patient.serviceType`/
 * `patient.deviceType` e preenchia as outras 5 colunas com `—`, mesmo com dado real no backend.
 * O teste abaixo assere sobre um paciente com UM serviço contratado (dispositivo, prestadores,
 * horas, local, valor) e falha se qualquer coluna voltar a mostrar placeholder para dado que
 * existe. Usa i18n REAL (molde `sex-both-i18n.test.tsx`) — sem isso o enum cru escaparia.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { ServicosContratadosCard } from '../ServicosContratadosCard';
import { patientDetailFixture } from './patientDetailFixture';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

// Dublê do drawer: isola os dois closures que o CARD passa pra ele (`onClose`/`onSaved`) sem
// precisar montar o drawer real (que busca a lista via API na hora que abre).
vi.mock('../edit/PatientContractedServicesEditDrawer', () => ({
  PatientContractedServicesEditDrawer: ({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) => (
    <div data-testid="patient-contracted-services-edit-drawer">
      <button type="button" onClick={onClose} data-testid="drawer-stub-close">close</button>
      <button type="button" onClick={onSaved} data-testid="drawer-stub-saved">saved</button>
    </div>
  ),
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
  professionalProfile: 'Perfil sintético — busca AT con experiencia en movilidad reducida.',
  providersNeeded: 2,
  authorizedHours: 20,
  weeklyHours: 20,
  careLocation: 'HOME',
  hourlyValue: 1500,
  hourlyValueRedacted: false,
  version: 'v1',
  startDate: '2026-09-01T00:00:00.000Z',
  contractType: 'OBRA_SOCIAL',
  taxCondition: 'IVA_EXEMPT',
  supervisionFrequency: 'DAYS_30',
  guardShift: 'MORNING',
  providerAgeBand: 'AGE_30_45',
  active: true,
  endedAt: null,
  country: 'AR',
  deviceTypes: ['HOME'],
  providers: [
    { id: 'p1', serviceId: 'svc-1', workerId: 'w1', workerName: 'Ana Fixture', weeklyHours: 20, active: true, endedAt: null, country: 'AR', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
  ],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

describe('ServicosContratadosCard — #PEND-08 (spec 013, bloco C)', () => {
  it('mostra dispositivo, prestadores, horas, local e valor REAIS — nenhuma coluna com dado existente vira "—"', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);

    const row = screen.getByTestId('contracted-service-row-svc-1');
    expect(row.textContent).toContain('Domicilio'); // careLocation traduzido — nunca "—"
    expect(row.textContent).not.toContain('—');

    // Dispositivo: traduzido, não o código cru nem vazio.
    expect(row.textContent).toContain('Domiciliario'); // deviceTypeOptions.HOME (es.json)

    // Prestadores necessários/ativos — "2 / 1" (1 dos 2 já alocado e ativo).
    expect(screen.getByTestId('contracted-service-providers-svc-1').textContent).toContain('2 / 1');

    // Valor real, não redigido para este ator (hourlyValueRedacted: false).
    expect(screen.getByTestId('contracted-service-value-svc-1').textContent).toContain('1500');

    // Spec 015 (US-A6.1): franja etária solicitada do prestador, traduzida — nunca o enum cru.
    expect(screen.getByTestId('contracted-service-age-band-svc-1').textContent).toBe('30 a 45 Años');

    expectNoRawEnumLeaks(row);
  });

  it('valor redigido (lex C-c.4): mostra o cadeado, nunca o número', () => {
    const redacted: PatientContractedServiceDetail = { ...SERVICE, id: 'svc-2', hourlyValue: null, hourlyValueRedacted: true };
    const patient = { ...patientDetailFixture, contractedServices: [redacted] };
    render(<ServicosContratadosCard patient={patient} />);

    const cell = screen.getByTestId('contracted-service-value-svc-2');
    expect(cell.textContent).not.toContain('1500');
    expect(cell.textContent).toContain('🔒');
  });

  it('sem serviços: empty state, não a tabela fantasma antiga', () => {
    const patient = { ...patientDetailFixture, contractedServices: [] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.queryByTestId(/contracted-service-row-/)).toBeNull();
    expect(screen.getByText(/No hay datos|Sin datos|—/i)).toBeTruthy();
  });

  it('serviço mínimo (todos os campos opcionais null/vazios): cada coluna mostra "—", nunca quebra', () => {
    const minimal: PatientContractedServiceDetail = {
      id: 'svc-min', patientId: patientDetailFixture.id, serviceCode: 'CAREGIVER', professionalProfile: null,
      providersNeeded: null, authorizedHours: null, weeklyHours: null, careLocation: null,
      hourlyValue: null, hourlyValueRedacted: false, version: null, startDate: null,
      contractType: null, taxCondition: null, supervisionFrequency: null, guardShift: null,
      providerAgeBand: null,
      active: false, endedAt: '2026-09-02T00:00:00Z', country: 'AR', deviceTypes: [], providers: [],
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    };
    const patient = { ...patientDetailFixture, contractedServices: [minimal] };
    render(<ServicosContratadosCard patient={patient} />);

    const row = screen.getByTestId('contracted-service-row-svc-min');
    // Badge de inativo aparece; dispositivo/local/versão/início/contratação/IVA viram "—".
    expect(row.textContent).toContain('Baja'); // inactiveBadge (es.json)
    // pair(null, 0 prestadores ativos) — QA-caça #3: providersNeeded null com 0 ativos é
    // "não sei quantos precisa, e há 0 alocados", NUNCA "0" bare (indistinguível de "precisa 0").
    expect(screen.getByTestId('contracted-service-providers-svc-min').textContent).toBe('— / 0');
    // pair(null, null) das horas: os dois lados null aqui → "—".
    expect(screen.getByTestId('contracted-service-hours-svc-min').textContent).toBe('—');
    expect(screen.getByTestId('contracted-service-value-svc-min').textContent).toContain('—');
    expect(screen.getByTestId('contracted-service-age-band-svc-min').textContent).toBe('—');
  });

  it('pair(): providersNeeded null com prestadores ativos > 0 mostra "— / N", nunca o número bare (QA-caça #3)', () => {
    const noNeedSet: PatientContractedServiceDetail = {
      ...SERVICE,
      id: 'svc-no-need',
      providersNeeded: null,
      providers: [
        { id: 'p1', serviceId: 'svc-no-need', workerId: 'w1', workerName: 'Ana Fixture', weeklyHours: 20, active: true, endedAt: null, country: 'AR', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'p2', serviceId: 'svc-no-need', workerId: 'w2', workerName: 'Beto Fixture', weeklyHours: 20, active: true, endedAt: null, country: 'AR', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' },
      ],
    };
    const patient = { ...patientDetailFixture, contractedServices: [noNeedSet] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.getByTestId('contracted-service-providers-svc-no-need').textContent).toBe('— / 2');
  });

  it('pair(): só um dos dois números presente mostra só ele (sem "/")', () => {
    const oneSide: PatientContractedServiceDetail = { ...SERVICE, id: 'svc-one', weeklyHours: 15, authorizedHours: null };
    const patient = { ...patientDetailFixture, contractedServices: [oneSide] };
    render(<ServicosContratadosCard patient={patient} />);
    const cell = screen.getByTestId('contracted-service-hours-svc-one');
    expect(cell.textContent).toBe('15');
  });

  it('botão "Editar servicios" abre o novo drawer de lista, não o antigo de campo único', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);
    fireEvent.click(screen.getByTestId('edit-service-btn'));
    expect(screen.getByTestId('patient-contracted-services-edit-drawer')).toBeTruthy();
  });

  it('onClose do drawer fecha (desmonta) o drawer; onSaved repassa pro onSaved do card (refetch do pai)', () => {
    const onSaved = vi.fn();
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('edit-service-btn'));

    fireEvent.click(screen.getByTestId('drawer-stub-saved'));
    expect(onSaved).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('drawer-stub-close'));
    expect(screen.queryByTestId('patient-contracted-services-edit-drawer')).toBeNull();
  });

  it('onSaved é opcional: sem onSaved passado, o clique no stub não quebra a tela', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);
    fireEvent.click(screen.getByTestId('edit-service-btn'));
    fireEvent.click(screen.getByTestId('drawer-stub-saved'));
    expect(screen.getByTestId('patient-contracted-services-edit-drawer')).toBeTruthy();
  });
});
