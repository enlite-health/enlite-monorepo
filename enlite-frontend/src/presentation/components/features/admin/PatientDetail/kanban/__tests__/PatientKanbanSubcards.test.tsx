/**
 * PatientKanbanSubcards.test.tsx — Fase 8 (change cadeia-paciente-vacante-itinerario), DX-8.6/8.7/8.8.
 *
 * O subcard é a linha `nome · cobertas/contratadas · ícone` dentro do card do Kanban de
 * pacientes. Invariante 3 ("o subcard só MOSTRA"): nenhum clique aqui pode disparar
 * `updatePatientStatus`/`activateRecruitment` — o foguete só NAVEGA para a ficha (DX-8.8).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { PatientKanbanSubcards } from '../PatientKanbanSubcards';
import type { PatientKanbanServiceSummary } from '@domain/entities/PatientDetail';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

function service(overrides: Partial<PatientKanbanServiceSummary> = {}): PatientKanbanServiceSummary {
  return {
    contractedServiceId: 's-1',
    serviceCode: 'AT',
    contratadas: { weekly: 20, authorized: 20 },
    cobertas: 4,
    liveVacancyId: null,
    ...overrides,
  };
}

function renderSubcards(services: PatientKanbanServiceSummary[] | undefined, patientId = 'p-1') {
  return render(
    <MemoryRouter>
      <PatientKanbanSubcards patientId={patientId} services={services} />
    </MemoryRouter>,
  );
}

describe('PatientKanbanSubcards (es)', () => {
  beforeAll(() => { i18n.changeLanguage('es'); });

  it('sem serviços (undefined) → nada no DOM', () => {
    const { container } = renderSubcards(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('sem serviços ([]) → nada no DOM', () => {
    const { container } = renderSubcards([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('2 serviços → 2 linhas com data-service-id próprio', () => {
    renderSubcards([
      service({ contractedServiceId: 's-1', serviceCode: 'AT' }),
      service({ contractedServiceId: 's-2', serviceCode: 'NURSE' }),
    ]);
    const rows = screen.getAllByTestId('patient-kanban-subcard');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-service-id', 's-1');
    expect(rows[1]).toHaveAttribute('data-service-id', 's-2');
  });

  it('par 4/20 (cobertas do itinerário / contratadas.weekly)', () => {
    renderSubcards([service({ cobertas: 4, contratadas: { weekly: 20, authorized: 20 } })]);
    expect(screen.getByTestId('patient-kanban-subcard-pair')).toHaveTextContent('4/20');
  });

  it('contratadas.weekly null → 4/—', () => {
    renderSubcards([service({ cobertas: 4, contratadas: { weekly: null, authorized: 20 } })]);
    expect(screen.getByTestId('patient-kanban-subcard-pair')).toHaveTextContent('4/—');
  });

  it('o nome do serviço vem de serviceTypes.<code> (a mesma chave da ficha)', () => {
    renderSubcards([service({ serviceCode: 'AT' })]);
    expect(screen.getByTestId('patient-kanban-subcard')).toHaveTextContent('Acompañante Terapéutico');
  });

  it('sem liveVacancyId → foguete; clique navega para a ficha e para a propagação (DX-8.8, não dispara ação)', () => {
    const onCardClick = vi.fn();
    render(
      <MemoryRouter>
        <div onClick={onCardClick}>
          <PatientKanbanSubcards patientId="p-42" services={[service({ liveVacancyId: null })]} />
        </div>
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('patient-kanban-subcard-vacancy')).toBeNull();
    const rocket = screen.getByTestId('patient-kanban-subcard-rocket');
    rocket.click();
    expect(mockNavigate).toHaveBeenCalledWith('/admin/patients/p-42');
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it('com liveVacancyId → link "ver vacante" com href, sem foguete', () => {
    renderSubcards([service({ liveVacancyId: 'v-9' })]);
    expect(screen.queryByTestId('patient-kanban-subcard-rocket')).toBeNull();
    expect(screen.getByTestId('patient-kanban-subcard-vacancy')).toHaveAttribute(
      'href',
      '/admin/vacancies/v-9',
    );
  });

  it('a linha do par tem role="group" (G2, achado 10 — aria-label num div sem role é ignorado pelo AT)', () => {
    renderSubcards([service()]);
    expect(screen.getByTestId('patient-kanban-subcard')).toHaveAttribute('role', 'group');
  });

  it('nenhuma cor literal (hex/rgba) no DOM renderizado', () => {
    const { container } = renderSubcards([service({ liveVacancyId: 'v-9' }), service({ contractedServiceId: 's-2', liveVacancyId: null })]);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});

describe('PatientKanbanSubcards (pt-BR)', () => {
  beforeAll(() => { i18n.changeLanguage('pt-BR'); });

  it('par e nome do serviço em pt-BR', () => {
    renderSubcards([service({ serviceCode: 'AT', cobertas: 4, contratadas: { weekly: 20, authorized: 20 } })]);
    expect(screen.getByTestId('patient-kanban-subcard-pair')).toHaveTextContent('4/20');
    expect(screen.getByTestId('patient-kanban-subcard')).toHaveTextContent('Acompanhante Terapêutico');
  });
});

// ── G2 (achado 1) — o foguete segue a MESMA regra da ficha (ServicosContratadosCard.tsx:74-78):
// só aparece com `patient_services:update` E `vacancy:update` JUNTAS. Mesmo molde de
// `comEnforcement` de PatientSupportNetworkEditDrawer.test.tsx (PR-8b rodada B). ──────────────
function comEnforcement(permissions: string[]) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement: 'on',
    } as AuthzContract,
  });
}

describe('PatientKanbanSubcards — gate do foguete (patient_services:update + vacancy:update)', () => {
  beforeAll(() => { i18n.changeLanguage('es'); });
  // N2 (gate fecho): `cleanup()` (unmount) ANTES do `setState` — o `afterEach` global de
  // `src/test/setup.ts` roda DEPOIS deste (outermost por último), então sem este `cleanup()`
  // aqui o `setState` disparava re-render num componente já "do teste anterior" ainda montado
  // → warning `not wrapped in act(...)`.
  afterEach(() => {
    cleanup();
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('com as duas células → foguete aparece', () => {
    comEnforcement(['patient_services:update', 'vacancy:update']);
    renderSubcards([service({ liveVacancyId: null })]);
    expect(screen.getByTestId('patient-kanban-subcard-rocket')).toBeInTheDocument();
  });

  it('sem as células (enforcement on, permissions vazio) → sem foguete, só nome · par', () => {
    comEnforcement([]);
    renderSubcards([service({ liveVacancyId: null })]);
    expect(screen.queryByTestId('patient-kanban-subcard-rocket')).toBeNull();
    expect(screen.getByTestId('patient-kanban-subcard-pair')).toBeInTheDocument();
  });

  it('só uma das duas células (patient_services:update sem vacancy:update) → sem foguete', () => {
    comEnforcement(['patient_services:update']);
    renderSubcards([service({ liveVacancyId: null })]);
    expect(screen.queryByTestId('patient-kanban-subcard-rocket')).toBeNull();
  });

  it('só a outra célula (vacancy:update sem patient_services:update) → sem foguete', () => {
    comEnforcement(['vacancy:update']);
    renderSubcards([service({ liveVacancyId: null })]);
    expect(screen.queryByTestId('patient-kanban-subcard-rocket')).toBeNull();
  });
});
