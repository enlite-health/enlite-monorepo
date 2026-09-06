/**
 * ServicosContratadosCard — spec 013, bloco C. Reproduz `#PEND-08` ("drawer com 1 campo;
 * dispositivo vazio") ANTES do fix: a versão anterior do card lia só `patient.serviceType`/
 * `patient.deviceType` e preenchia as outras 5 colunas com `—`, mesmo com dado real no backend.
 * O teste abaixo assere sobre um paciente com UM serviço contratado (dispositivo, prestadores,
 * horas, local, valor) e falha se qualquer coluna voltar a mostrar placeholder para dado que
 * existe. Usa i18n REAL (molde `sex-both-i18n.test.tsx`) — sem isso o enum cru escaparia.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
  addressId: null,
  schedule: null,
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

const ADDRESS_HOME = { ...patientDetailFixture.addresses[0], id: 'addr-home', addressFormatted: 'Rua Augusta, 975 - Centro', addressRaw: null };
const ADDRESS_SCHOOL = { ...patientDetailFixture.addresses[0], id: 'addr-school', addressFormatted: null, addressRaw: 'Av. Cruzeiro do Sul, 1212' };
const SCHEDULE = [
  { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
  { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
];

/**
 * 05/09 (decisão do Gabriel): a tabela passa a ter as 5 colunas do Figma — Dispositivo ·
 * Servicio · Cant. · Lugar (+ domicilio embaixo) · Horarios. Valor/IVA/versão/contratação/franja
 * saem da tabela e vivem no DETALHE (clique na linha). O endereço é resolvido pelo ponteiro
 * `addressId` contra `patient.addresses` (migration 330) — nada é copiado no serviço.
 */
describe('ServicosContratadosCard — tabela no molde do Figma (05/09) + #PEND-08', () => {
  it('mostra dispositivo, serviço, quantidade, lugar + ENDEREÇO vinculado e horário — nenhuma coluna com dado existente vira "—"', () => {
    const svc: PatientContractedServiceDetail = { ...SERVICE, addressId: 'addr-home', schedule: SCHEDULE };
    const patient = { ...patientDetailFixture, addresses: [ADDRESS_HOME, ADDRESS_SCHOOL], contractedServices: [svc] };
    render(<ServicosContratadosCard patient={patient} />);

    const row = screen.getByTestId('contracted-service-row-svc-1');
    expect(row.textContent).not.toContain('—');
    expect(row.textContent).toContain('Domiciliario'); // deviceTypeOptions.HOME (es.json)
    expect(row.textContent).toContain('Domicilio'); // careLocationOptions.HOME
    expect(screen.getByTestId('contracted-service-providers-svc-1').textContent).toBe('2');
    // Endereço: o do PONTEIRO (addr-home), não o primeiro da lista nem o da escola.
    expect(screen.getByTestId('contracted-service-address-svc-1').textContent).toBe('Rua Augusta, 975 - Centro');
    expect(row.textContent).not.toContain('Cruzeiro do Sul');
    expect(screen.queryByTestId('contracted-service-address-missing-svc-1')).toBeNull();
    // Horário serializado como na vaga: dias + faixa.
    expect(screen.getByTestId('contracted-service-schedule-svc-1').textContent).toBe('Lunes, Miércoles 08:00-12:00');
    // As colunas de contrato NÃO estão mais na tabela.
    expect(row.textContent).not.toContain('1500');
    expect(row.textContent).not.toContain('30 a 45');

    expectNoRawEnumLeaks(row);
  });

  it('serviço SEM endereço vinculado mostra o aviso na linha (é o que trava a ativação), nunca um "—" mudo', () => {
    const patient = { ...patientDetailFixture, addresses: [ADDRESS_HOME], contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.getByTestId('contracted-service-address-missing-svc-1').textContent).toBe('Sin domicilio vinculado');
    expect(screen.queryByTestId('contracted-service-address-svc-1')).toBeNull();
  });

  it('serviço apontando para endereço que NÃO está na ficha (arquivado) conta como sem endereço', () => {
    const svc = { ...SERVICE, addressId: 'addr-arquivado' };
    const patient = { ...patientDetailFixture, addresses: [ADDRESS_HOME], contractedServices: [svc] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.getByTestId('contracted-service-address-missing-svc-1')).toBeTruthy();
  });

  it('endereço sem texto do geocoder cai no texto cru do operador (mesmo fallback de LocalizacoesCard)', () => {
    const svc = { ...SERVICE, addressId: 'addr-school' };
    const patient = { ...patientDetailFixture, addresses: [ADDRESS_SCHOOL], contractedServices: [svc] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.getByTestId('contracted-service-address-svc-1').textContent).toBe('Av. Cruzeiro do Sul, 1212');
  });

  it('sem horário: "Sin horario" (estado legítimo — a vaga pode nascer sem horário)', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.getByTestId('contracted-service-schedule-svc-1').textContent).toBe('Sin horario');
  });

  it('sem serviços: empty state, não a tabela fantasma antiga', () => {
    const patient = { ...patientDetailFixture, contractedServices: [] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.queryByTestId(/contracted-service-row-/)).toBeNull();
    expect(screen.getByText(/No hay datos|Sin datos|—/i)).toBeTruthy();
  });

  it('serviço mínimo (tudo null): dispositivo e lugar viram "—", quantidade "—", badge de baixa aparece, nunca quebra', () => {
    const minimal: PatientContractedServiceDetail = {
      id: 'svc-min', patientId: patientDetailFixture.id, serviceCode: 'CAREGIVER', professionalProfile: null,
      providersNeeded: null, authorizedHours: null, weeklyHours: null, careLocation: null,
      hourlyValue: null, hourlyValueRedacted: false, version: null, startDate: null,
      contractType: null, taxCondition: null, supervisionFrequency: null, guardShift: null,
      providerAgeBand: null,
      addressId: null,
      schedule: null,
      active: false, endedAt: '2026-09-02T00:00:00Z', country: 'AR', deviceTypes: [], providers: [],
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    };
    const patient = { ...patientDetailFixture, contractedServices: [minimal] };
    render(<ServicosContratadosCard patient={patient} />);

    const row = screen.getByTestId('contracted-service-row-svc-min');
    expect(row.textContent).toContain('Baja'); // inactiveBadge (es.json)
    expect(screen.getByTestId('contracted-service-providers-svc-min').textContent).toBe('—');
    expect(screen.getByTestId('contracted-service-location-svc-min').textContent).toContain('—');
  });

  it('clique na linha abre o DETALHE completo (só leitura) com valor, franja, IVA, prestadores e endereço; fechar desmonta', () => {
    const svc: PatientContractedServiceDetail = { ...SERVICE, addressId: 'addr-home', schedule: SCHEDULE };
    const patient = { ...patientDetailFixture, addresses: [ADDRESS_HOME], contractedServices: [svc] };
    render(<ServicosContratadosCard patient={patient} />);

    expect(screen.queryByTestId('contracted-service-detail-drawer')).toBeNull();
    fireEvent.click(screen.getByTestId('contracted-service-row-svc-1'));
    const drawer = screen.getByTestId('contracted-service-detail-drawer');
    expect(screen.getByTestId('svc-detail-value').textContent).toContain('1500');
    expect(screen.getByTestId('svc-detail-age-band').textContent).toContain('30 a 45 Años');
    expect(screen.getByTestId('svc-detail-address').textContent).toContain('Rua Augusta, 975 - Centro');
    expect(screen.getByTestId('svc-detail-schedule').textContent).toContain('Lunes, Miércoles 08:00-12:00');
    expect(screen.getByTestId('svc-detail-providers').textContent).toContain('Ana Fixture');
    expect(screen.getByTestId('svc-detail-profile').textContent).toContain('Perfil sintético');
    expectNoRawEnumLeaks(drawer);

    // Fechar: anima (translate) e desmonta depois de CLOSE_MS — o pai só limpa `selected` no
    // callback, então sem avançar o relógio o drawer ainda está no DOM.
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('contracted-service-detail-close'));
    expect(screen.getByTestId('contracted-service-detail-drawer')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByTestId('contracted-service-detail-drawer')).toBeNull();
    vi.useRealTimers();
  });

  it('detalhe fecha também pelo backdrop e pela tecla Escape', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);

    fireEvent.click(screen.getByTestId('contracted-service-row-svc-1'));
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('contracted-service-detail-backdrop'));
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByTestId('contracted-service-detail-drawer')).toBeNull();
    vi.useRealTimers();

    fireEvent.click(screen.getByTestId('contracted-service-row-svc-1'));
    vi.useFakeTimers();
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByTestId('contracted-service-detail-drawer')).toBeNull();
    // Tecla que não é Escape não fecha.
    fireEvent.click(screen.getByTestId('contracted-service-row-svc-1'));
    fireEvent.keyDown(window, { key: 'Enter' });
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByTestId('contracted-service-detail-drawer')).toBeTruthy();
    vi.useRealTimers();
  });

  it('detalhe: valor redigido (lex C-c.4) mostra o cadeado, nunca o número; sem endereço/horário/prestadores mostra os rótulos', () => {
    const redacted: PatientContractedServiceDetail = {
      ...SERVICE, id: 'svc-2', hourlyValue: null, hourlyValueRedacted: true, professionalProfile: null, providers: [],
    };
    const patient = { ...patientDetailFixture, contractedServices: [redacted] };
    render(<ServicosContratadosCard patient={patient} />);
    fireEvent.click(screen.getByTestId('contracted-service-row-svc-2'));
    expect(screen.getByTestId('svc-detail-value').textContent).toContain('🔒');
    expect(screen.getByTestId('svc-detail-value').textContent).not.toContain('1500');
    expect(screen.getByTestId('svc-detail-address').textContent).toContain('Sin domicilio vinculado');
    expect(screen.getByTestId('svc-detail-schedule').textContent).toContain('Sin horario');
    expect(screen.getByTestId('svc-detail-providers').textContent).toContain('Sin prestadores asignados');
    expect(screen.queryByTestId('svc-detail-profile')).toBeNull();
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
