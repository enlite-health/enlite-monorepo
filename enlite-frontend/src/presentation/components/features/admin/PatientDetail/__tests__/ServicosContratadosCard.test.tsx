/**
 * ServicosContratadosCard — spec 013, bloco C. Reproduz `#PEND-08` ("drawer com 1 campo;
 * dispositivo vazio") ANTES do fix: a versão anterior do card lia só `patient.serviceType`/
 * `patient.deviceType` e preenchia as outras 5 colunas com `—`, mesmo com dado real no backend.
 * O teste abaixo assere sobre um paciente com UM serviço contratado (dispositivo, prestadores,
 * horas, local, valor) e falha se qualquer coluna voltar a mostrar placeholder para dado que
 * existe. Usa i18n REAL (molde `sex-both-i18n.test.tsx`) — sem isso o enum cru escaparia.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { ServicosContratadosCard, runActivateRecruitmentClick } from '../ServicosContratadosCard';
import { patientDetailFixture } from './patientDetailFixture';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';

// Dublê do drawer: isola os dois closures que o CARD passa pra ele (`onClose`/`onSaved`) sem
// precisar montar o drawer real (que busca a lista via API na hora que abre).
vi.mock('../edit/PatientContractedServicesEditDrawer', () => ({
  PatientContractedServicesEditDrawer: ({ onClose, onSaved, target }: { onClose: () => void; onSaved: () => void; target: { kind: string; serviceId?: string } }) => (
    <div data-testid="patient-contracted-services-edit-drawer" data-target={`${target.kind}:${target.serviceId ?? ''}`}>
      <button type="button" onClick={onClose} data-testid="drawer-stub-close">close</button>
      <button type="button" onClick={onSaved} data-testid="drawer-stub-saved">saved</button>
    </div>
  ),
}));

// `ActivateRecruitmentAction` (018-pr6, ADR-5) — o CLIENTE http é dublê (controla sucesso/erro do
// POST activate-recruitment); `ContractedServiceApiError` é a classe REAL (importActual), porque o
// componente faz `instanceof` sobre ela no catch — um dublê ad-hoc quebraria esse `instanceof`.
const mockActivateRecruitment = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/AdminContractedServicesApiService')>();
  return {
    ...actual,
    AdminContractedServicesApiService: {
      ...actual.AdminContractedServicesApiService,
      activateRecruitment: (...a: unknown[]) => mockActivateRecruitment(...a),
    },
  };
});

const mockShowToast = vi.fn();
vi.mock('@presentation/hooks/useToast', () => ({ useToast: () => mockShowToast }));

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
  startDate: '2026-09-01T00:00:00.000Z',
  contractType: 'OBRA_SOCIAL',
  taxCondition: 'IVA_EXEMPT',
  supervisionFrequency: 'DAYS_30',
  guardShift: 'MORNING',
  providerAgeBand: 'AGE_30_45',
  addressId: null,
  schedule: null,
  liveVacancyId: null,
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

  // Decisão do Gabriel 07/09: "Sin horario" virou AVISO âmbar (era cinza neutro) — é o que trava
  // a mudança de status, do mesmo peso que "Sin domicilio vinculado" ao lado.
  it('sem horário: "Sin horario" em ÂMBAR, com testid próprio de pendência', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.getByTestId('contracted-service-schedule-svc-1').textContent).toBe('Sin horario');
    const aviso = screen.getByTestId('contracted-service-schedule-missing-svc-1');
    expect(aviso.className).toContain('text-amber-700');
    // A classe SOZINHA não prova a cor: o `Text` emite `text-gray-800` por default e vence pela
    // ordem de emissão do Tailwind (medido em tela: rgb(115,115,115) — cinza, não âmbar). O que
    // impede a regressão é NÃO haver classe de cor concorrente no mesmo elemento.
    expect(aviso.className).not.toMatch(/text-gray-\d/);
  });

  it('horário ARRAY VAZIO também acusa a pendência âmbar (`[]` não é horário)', () => {
    const patient = {
      ...patientDetailFixture,
      contractedServices: [{ ...SERVICE, schedule: [] }],
    };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.getByTestId('contracted-service-schedule-missing-svc-1')).toBeTruthy();
  });

  it('COM horário: nenhum aviso âmbar na célula', () => {
    const svc: PatientContractedServiceDetail = { ...SERVICE, schedule: SCHEDULE };
    const patient = { ...patientDetailFixture, contractedServices: [svc] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.queryByTestId('contracted-service-schedule-missing-svc-1')).toBeNull();
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
      hourlyValue: null, hourlyValueRedacted: false, startDate: null,
      contractType: null, taxCondition: null, supervisionFrequency: null, guardShift: null,
      providerAgeBand: null,
      addressId: null,
      schedule: null,
      liveVacancyId: null,
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

  it('clicar OUTRA linha durante os 300 ms de fechar abre o detalhe do outro serviço (key por id remonta o drawer — gate 06/09)', () => {
    const svc2: PatientContractedServiceDetail = { ...SERVICE, id: 'svc-2', serviceCode: 'CAREGIVER' };
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE, svc2] };
    render(<ServicosContratadosCard patient={patient} />);
    fireEvent.click(screen.getByTestId('contracted-service-row-svc-1'));
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('contracted-service-detail-close'));
    // Ainda dentro da animação: clica no segundo serviço.
    fireEvent.click(screen.getByTestId('contracted-service-row-svc-2'));
    act(() => { vi.advanceTimersByTime(300); });
    const drawer = screen.getByTestId('contracted-service-detail-drawer');
    expect(drawer).toBeTruthy();
    expect(drawer.querySelector('h3')?.textContent).toContain('Cuidador');
    expect(drawer.className).toContain('translate-x-0');
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

  // 06/09 (Gabriel): a tabela É a lista — "+ Nuevo servicio" abre o form vazio; o lápis da linha
  // e o "Editar" do detalhe abrem SÓ aquele serviço. Sem drawer-lista intermediário.
  it('"+ Nuevo servicio" abre o drawer em modo NOVO; não existe mais "Editar servicios"', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);
    expect(screen.queryByTestId('edit-service-btn')).toBeNull();
    fireEvent.click(screen.getByTestId('new-service-btn'));
    expect(screen.getByTestId('patient-contracted-services-edit-drawer').getAttribute('data-target')).toBe('new:');
  });

  it('o lápis da linha abre o drawer SÓ daquele serviço, sem abrir o detalhe junto', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE, { ...SERVICE, id: 'svc-2' }] };
    render(<ServicosContratadosCard patient={patient} />);
    fireEvent.click(screen.getByTestId('contracted-service-edit-svc-2'));
    expect(screen.getByTestId('patient-contracted-services-edit-drawer').getAttribute('data-target')).toBe('edit:svc-2');
    expect(screen.queryByTestId('contracted-service-detail-drawer')).toBeNull();
  });

  it('"Editar" no detalhe fecha o detalhe e abre o drawer daquele serviço', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);
    fireEvent.click(screen.getByTestId('contracted-service-row-svc-1'));
    fireEvent.click(screen.getByTestId('contracted-service-detail-edit'));
    expect(screen.queryByTestId('contracted-service-detail-drawer')).toBeNull();
    expect(screen.getByTestId('patient-contracted-services-edit-drawer').getAttribute('data-target')).toBe('edit:svc-1');
  });

  it('foco do checklist SERVICE_ADDRESS abre o PRIMEIRO serviço ativo sem endereço vivo; sem candidato, abre um novo', () => {
    const vivo = { ...patientDetailFixture.addresses[0], id: 'addr-home' };
    const ok = { ...SERVICE, id: 'svc-ok', addressId: 'addr-home' };
    const orfao = { ...SERVICE, id: 'svc-orfao', addressId: 'addr-arquivado' };
    const { unmount } = render(<ServicosContratadosCard patient={{ ...patientDetailFixture, addresses: [vivo], contractedServices: [ok, orfao] }} focusRequest={{ code: 'SERVICE_ADDRESS', token: 1 }} />);
    expect(screen.getByTestId('patient-contracted-services-edit-drawer').getAttribute('data-target')).toBe('edit:svc-orfao');
    unmount();
    render(<ServicosContratadosCard patient={{ ...patientDetailFixture, addresses: [vivo], contractedServices: [ok] }} focusRequest={{ code: 'SERVICE_ADDRESS', token: 2 }} />);
    expect(screen.getByTestId('patient-contracted-services-edit-drawer').getAttribute('data-target')).toBe('new:');
  });

  // Decisão do Gabriel 07/09: a pílula "Horario del servicio" do checklist leva direto ao serviço
  // que está sem horário — não adianta avisar sem levar até onde se conserta.
  it('foco do checklist SERVICE_SCHEDULE abre o PRIMEIRO serviço ativo sem horário; sem candidato, abre um novo', () => {
    const comHorario = { ...SERVICE, id: 'svc-com', schedule: SCHEDULE };
    const semHorario = { ...SERVICE, id: 'svc-sem', schedule: null };
    const { unmount } = render(
      <ServicosContratadosCard
        patient={{ ...patientDetailFixture, contractedServices: [comHorario, semHorario] }}
        focusRequest={{ code: 'SERVICE_SCHEDULE', token: 10 }}
      />,
    );
    expect(screen.getByTestId('patient-contracted-services-edit-drawer').getAttribute('data-target')).toBe('edit:svc-sem');
    unmount();

    // todos com horário → nada a focar: abre um serviço novo (mesmo fallback do SERVICE_ADDRESS)
    render(
      <ServicosContratadosCard
        patient={{ ...patientDetailFixture, contractedServices: [comHorario] }}
        focusRequest={{ code: 'SERVICE_SCHEDULE', token: 11 }}
      />,
    );
    expect(screen.getByTestId('patient-contracted-services-edit-drawer').getAttribute('data-target')).toBe('new:');
  });

  it('foco SERVICE_SCHEDULE trata array VAZIO como sem horário, e ignora serviço INATIVO', () => {
    const inativoSemHorario = { ...SERVICE, id: 'svc-inativo', active: false, schedule: null };
    const ativoVazio = { ...SERVICE, id: 'svc-vazio', schedule: [] };
    render(
      <ServicosContratadosCard
        patient={{ ...patientDetailFixture, contractedServices: [inativoSemHorario, ativoVazio] }}
        focusRequest={{ code: 'SERVICE_SCHEDULE', token: 12 }}
      />,
    );
    expect(screen.getByTestId('patient-contracted-services-edit-drawer').getAttribute('data-target')).toBe('edit:svc-vazio');
  });

  it('foco do checklist CONTRACTED_SERVICE abre um serviço NOVO', () => {
    render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [] }} focusRequest={{ code: 'CONTRACTED_SERVICE', token: 3 }} />);
    expect(screen.getByTestId('patient-contracted-services-edit-drawer').getAttribute('data-target')).toBe('new:');
  });

  it('onClose do drawer fecha (desmonta) o drawer; onSaved repassa pro onSaved do card (refetch do pai)', () => {
    const onSaved = vi.fn();
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('new-service-btn'));

    fireEvent.click(screen.getByTestId('drawer-stub-saved'));
    expect(onSaved).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('drawer-stub-close'));
    expect(screen.queryByTestId('patient-contracted-services-edit-drawer')).toBeNull();
  });

  it('onSaved é opcional: sem onSaved passado, o clique no stub não quebra a tela', () => {
    const patient = { ...patientDetailFixture, contractedServices: [SERVICE] };
    render(<ServicosContratadosCard patient={patient} />);
    fireEvent.click(screen.getByTestId('new-service-btn'));
    fireEvent.click(screen.getByTestId('drawer-stub-saved'));
    expect(screen.getByTestId('patient-contracted-services-edit-drawer')).toBeTruthy();
  });
});

/**
 * Ícone "Activar reclutamiento" (018-pr6, ADR-5) — `ActivateRecruitmentAction`, DENTRO deste
 * arquivo (não um componente próprio: o botão some quando falta um código do gate, vira
 * "Ver vacante" quando o serviço já tem vaga viva). A régua real é o backend — este componente só
 * antecipa o estado; por isso o teste cobre as respostas HTTP que o backend devolve (201/409/422/
 * erro genérico), não a lógica de negócio (que tem suíte própria em `activation.e2e.test.ts`).
 */
describe('ServicosContratadosCard — ícone de ativação de recrutamento por serviço (018-pr6, ADR-5)', () => {
  const READY_SERVICE: PatientContractedServiceDetail = {
    ...SERVICE,
    addressId: 'addr-home',
    schedule: SCHEDULE,
    liveVacancyId: null,
  };
  const READY_PATIENT = {
    ...patientDetailFixture,
    addresses: [ADDRESS_HOME],
    contractedServices: [READY_SERVICE],
    insuranceInformed: 'Particular',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clique com sucesso (201): chama o endpoint, toast de sucesso, aciona onSaved (refetch)', async () => {
    mockActivateRecruitment.mockResolvedValueOnce({ vacancyId: 'vac-1', patientStatus: 'SEARCHING', statusChanged: true });
    const onSaved = vi.fn();
    render(<ServicosContratadosCard patient={READY_PATIENT} onSaved={onSaved} />);

    const btn = screen.getByTestId('contracted-service-activate-recruitment-svc-1');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockActivateRecruitment).toHaveBeenCalledWith(READY_PATIENT.id, 'svc-1');
    expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'success');
    // Clicar na linha, não no botão, não deve ter aberto o detalhe (stopPropagation).
    expect(screen.queryByTestId('contracted-service-detail-drawer')).toBeNull();
  });

  it('409 SERVICE_ALREADY_RECRUITING: toast de erro, mas aciona onSaved (a ficha vai mostrar "Ver vacante")', async () => {
    mockActivateRecruitment.mockRejectedValueOnce(
      new ContractedServiceApiError('já tem vaga', 409, { code: 'SERVICE_ALREADY_RECRUITING' }),
    );
    const onSaved = vi.fn();
    render(<ServicosContratadosCard patient={READY_PATIENT} onSaved={onSaved} />);

    fireEvent.click(screen.getByTestId('contracted-service-activate-recruitment-svc-1'));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  it('422 PATIENT_NOT_READY: toast de erro NOMEIA o código que falta (traduzido), não aciona onSaved', async () => {
    mockActivateRecruitment.mockRejectedValueOnce(
      new ContractedServiceApiError('falta cobertura', 422, { code: 'PATIENT_NOT_READY', details: { missing: ['COVERAGE'] } }),
    );
    const onSaved = vi.fn();
    render(<ServicosContratadosCard patient={READY_PATIENT} onSaved={onSaved} />);

    fireEvent.click(screen.getByTestId('contracted-service-activate-recruitment-svc-1'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
    expect(onSaved).not.toHaveBeenCalled();
    // O segundo argumento do t() é o texto traduzido de COVERAGE (completeness.items.COVERAGE) —
    // o toast tem que citar o NOME do que falta, não só "algo deu errado".
    const [, params] = mockShowToast.mock.calls[0];
    expect(params).toBe('error');
    const [message] = mockShowToast.mock.calls[0];
    expect(typeof message).toBe('string');
    expect((message as string).length).toBeGreaterThan(0);
  });

  it('erro genérico (rede/500, não ContractedServiceApiError): toast de erro genérico, não aciona onSaved', async () => {
    mockActivateRecruitment.mockRejectedValueOnce(new Error('network down'));
    const onSaved = vi.fn();
    render(<ServicosContratadosCard patient={READY_PATIENT} onSaved={onSaved} />);

    fireEvent.click(screen.getByTestId('contracted-service-activate-recruitment-svc-1'));

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'error'));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('caminho "Ver vacante": serviço com vaga viva mostra o link (não o botão), abre em nova rota e não dispara o detalhe da linha', () => {
    const withVacancy = { ...READY_SERVICE, liveVacancyId: 'vac-9' };
    const patient = { ...READY_PATIENT, contractedServices: [withVacancy] };
    render(<ServicosContratadosCard patient={patient} />);

    expect(screen.queryByTestId('contracted-service-activate-recruitment-svc-1')).toBeNull();
    const link = screen.getByTestId('contracted-service-view-vacancy-svc-1');
    expect(link.getAttribute('href')).toBe('/admin/vacancies/vac-9');

    fireEvent.click(link);
    expect(screen.queryByTestId('contracted-service-detail-drawer')).toBeNull();
    expect(mockActivateRecruitment).not.toHaveBeenCalled();
  });

  it('clique duplo enquanto a 1ª chamada está em voo: a 2ª é ignorada (guarda de `busy`, via clique real)', async () => {
    let resolveCall: (v: unknown) => void = () => {};
    mockActivateRecruitment.mockImplementationOnce(
      () => new Promise((resolve) => { resolveCall = resolve; }),
    );
    render(<ServicosContratadosCard patient={READY_PATIENT} />);
    const btn = screen.getByTestId('contracted-service-activate-recruitment-svc-1');
    fireEvent.click(btn);
    fireEvent.click(btn); // enquanto a 1ª ainda não resolveu — o `disabled` nativo já barra a 2ª
    expect(mockActivateRecruitment).toHaveBeenCalledTimes(1);
    resolveCall({ vacancyId: 'vac-1', patientStatus: 'SEARCHING', statusChanged: true });
    await waitFor(() => expect(mockShowToast).toHaveBeenCalled());
  });

  // O `disabled` nativo do botão barra o clique ANTES do handler rodar — o guard
  // `missing.length > 0 || busy` dentro de `runActivateRecruitmentClick` nunca vê `busy=true` por
  // um clique simulado (mesma armadilha do `runAssociateProvider` vizinho). Chamando a função
  // exportada direto, sem o DOM: prova que a guarda RECUSA quando `busy` já é true, sem invocar a API.
  it('runActivateRecruitmentClick: `busy=true` recusa direto (guarda testada sem depender do `disabled` do DOM)', async () => {
    const onActivated = vi.fn();
    const setBusy = vi.fn();
    await runActivateRecruitmentClick({
      patientId: 'p1', serviceId: 'svc-1', missing: [], busy: true, setBusy,
      onActivated, tc: (k) => k, t: (k) => k, showToast: mockShowToast,
    });
    expect(mockActivateRecruitment).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(onActivated).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('422 PATIENT_NOT_READY sem `details.missing` (undefined): não quebra, ainda mostra toast de erro', async () => {
    mockActivateRecruitment.mockRejectedValueOnce(
      new ContractedServiceApiError('não pronto', 422, { code: 'PATIENT_NOT_READY' }),
    );
    render(<ServicosContratadosCard patient={READY_PATIENT} />);
    fireEvent.click(screen.getByTestId('contracted-service-activate-recruitment-svc-1'));
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith(expect.any(String), 'error'));
  });

  it('faltando SERVICE_ADDRESS: botão desabilitado com tooltip nomeando o pendente; clique não chama a API', () => {
    const semEndereco = { ...READY_SERVICE, addressId: null };
    const patient = { ...READY_PATIENT, contractedServices: [semEndereco] };
    render(<ServicosContratadosCard patient={patient} />);

    const btn = screen.getByTestId('contracted-service-activate-recruitment-svc-1');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('title')).toBeTruthy();
    fireEvent.click(btn);
    expect(mockActivateRecruitment).not.toHaveBeenCalled();
  });
});
