/**
 * PatientVacanciesCard — bloco "Vacantes Generadas" (spec 047, F4): o código da vaga é `formatVacancyCase`
 * (`EN1234#01`), o MESMO da coluna "Código de la vacante" da tabela de serviços.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { PatientVacanciesCard } from '../PatientVacanciesCard';
import { ServicosContratadosCard } from '../ServicosContratadosCard';
import { patientDetailFixture } from './patientDetailFixture';
import type { PatientVacancySummary, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

const translations = ptBR as Record<string, any>;
function t(key: string, opts?: any): string {
  let cur: any = translations;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur === 'string') return cur;
  if (typeof opts === 'string') return opts;
  return typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) }));
vi.mock('../edit/PatientContractedServicesEditDrawer', () => ({ PatientContractedServicesEditDrawer: () => null }));
vi.mock('../ContractedServiceDetailDrawer', () => ({ ContractedServiceDetailDrawer: () => null }));

const VAGA: PatientVacancySummary = {
  id: 'v-1', caseNumber: 1234, caseOrdinal: 1, vacancyNumber: 77, title: 'Vaga do caso', status: 'SEARCHING', isDraft: false, createdAt: '2026-09-01T00:00:00Z',
};
const lista = (v: PatientVacancySummary[]) => <PatientVacanciesCard patientId="p1" vacancies={v} isLoading={false} error={null} />;

describe('PatientVacanciesCard — código da vaga em EN1234#01 (spec 047 F4)', () => {
  it('A1: mostra EN1234#01 (texto exato) e NÃO o formato antigo CASO 1234-77', () => {
    const { container } = render(lista([VAGA]));
    expect(screen.getByText('EN1234#01')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/CASO 1234|CASO EN1234|-77/);
  });

  it('A3: vaga legada sem ordinal (NULL) → só o número do caso (fallback de formatVacancyCase), a linha segue inteira com título e badge', () => {
    render(lista([{ ...VAGA, caseOrdinal: null }]));
    expect(screen.getByText('EN1234')).toBeInTheDocument();
    expect(screen.getByText('Vaga do caso')).toBeInTheDocument();
  });

  it('caso legado do ClickUp (< 1000) sem prefixo EN: 812#02', () => {
    render(lista([{ ...VAGA, caseNumber: 812, caseOrdinal: 2 }]));
    expect(screen.getByText('812#02')).toBeInTheDocument();
  });

  it('vaga sem paciente visível (caseNumber null) → cai no título, ou "—" sem título; nunca quebra', () => {
    const { rerender } = render(lista([{ ...VAGA, caseNumber: null, caseOrdinal: null, title: 'Só o título' }]));
    expect(screen.getByText('Só o título')).toBeInTheDocument();
    rerender(lista([{ ...VAGA, caseNumber: null, caseOrdinal: null, title: null }]));
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('A2: para a MESMA vaga o texto do bloco é IGUAL ao da coluna "Código da vacante" da tabela de serviços (um dono só)', () => {
    const servico = {
      id: 'svc-x', patientId: 'p1', serviceCode: 'AT', professionalProfile: null, providersNeeded: 1, authorizedHours: null, weeklyHours: null,
      careLocation: null, hourlyValue: null, hourlyValueRedacted: false, startDate: null, contractType: null, taxCondition: null,
      supervisionFrequency: null, guardShift: null, providerAgeBand: null, addressId: null, schedule: null, endedAt: null, country: 'AR',
      deviceTypes: [], providers: [], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', active: true,
      liveVacancy: { id: 'v-1', caseNumber: VAGA.caseNumber, caseOrdinal: VAGA.caseOrdinal, status: VAGA.status }, liveVacancyRedacted: false,
    } as PatientContractedServiceDetail;
    render(<ServicosContratadosCard patient={{ ...patientDetailFixture, contractedServices: [servico] }} />);
    const naColuna = screen.getByTestId('contracted-service-vacancy-link-svc-x').textContent;
    const { unmount } = render(lista([VAGA]));
    const card = screen.getByTestId('patient-vacancies-card');
    expect(card.textContent).toContain(naColuna as string);
    expect(naColuna).toBe('EN1234#01');
    unmount();
  });

  it('badges: rascunho mostra o selo, status sem cor mapeada cai no cinza, status nulo não renderiza badge', () => {
    render(lista([
      { ...VAGA, id: 'a', isDraft: true, status: 'SEARCHING' },
      { ...VAGA, id: 'b', caseOrdinal: 2, status: 'OUTRO_STATUS' },
      { ...VAGA, id: 'c', caseOrdinal: 3, status: null },
    ]));
    expect(screen.getByText(translations.admin.vacancies.table.draftBadge)).toBeInTheDocument();
    expect(screen.getByText('OUTRO_STATUS').parentElement?.className).toContain('bg-gray-100');
    expect(screen.getByText('EN1234#03')).toBeInTheDocument();
  });

  it('vazio e erro seguem como antes', () => {
    const { rerender } = render(lista([]));
    expect(screen.getByText(translations.admin.patients.detail.vacanciesCard.empty)).toBeInTheDocument();
    rerender(<PatientVacanciesCard patientId="p1" vacancies={[]} isLoading={false} error="x" />);
    expect(screen.getByText(translations.admin.patients.detail.vacanciesCard.error)).toBeInTheDocument();
  });
});
