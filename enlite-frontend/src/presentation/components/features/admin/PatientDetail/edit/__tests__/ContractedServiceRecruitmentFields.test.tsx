/**
 * Spec 027 Fase 3 (T024): os 7 campos de recrutamento no formulário do serviço contratado.
 * Prova: pré-carrega; a máscara do Clarity cobre os 4 textos livres (lex T.3); NÃO existe campo de motivo do
 * sexo (lex S.4, D507 item 4); salvar envia os valores; limpar envia `null`.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { ContractedServiceFormRow } from '../ContractedServiceFormRow';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    createContractedService: (...a: unknown[]) => mockCreate(...a),
    updateContractedService: (...a: unknown[]) => mockUpdate(...a),
  },
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { listWorkers: vi.fn().mockResolvedValue({ data: [] }) },
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const SERVICE: PatientContractedServiceDetail = {
  id: 's1', patientId: 'pat1', serviceCode: 'AT', professionalProfile: 'perfil sintético',
  providersNeeded: 2, authorizedHours: 20, weeklyHours: 20, careLocation: 'HOME',
  hourlyValue: 1500, hourlyValueRedacted: false, startDate: '2026-09-01T00:00:00.000Z',
  contractType: 'OBRA_SOCIAL', taxCondition: 'IVA_EXEMPT', supervisionFrequency: 'DAYS_30', guardShift: 'MORNING',
  providerAgeBand: 'AGE_30_45', requiredProfessions: ['AT'], requiredSex: 'F', requiredExperience: 'exp-sintetica', workerAttributes: 'atrib-sintetico', workSchedule: 'part-time', paymentDay: 'dia 5', dailyObs: 'obs-sintetica',
  addressId: null,
  liveVacancy: null, liveVacancyRedacted: false,
  schedule: null,
  active: true, endedAt: null, country: 'AR', deviceTypes: ['HOME'], providers: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};


const renderRow = (service: PatientContractedServiceDetail | null = SERVICE) =>
  render(<ContractedServiceFormRow patientId="pat1" addresses={[]} service={service} index={1} onSaved={vi.fn()} />);

describe('ContractedServiceFormRow — campos de recrutamento (spec 027 Fase 3)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('pré-carrega os 7 campos do serviço', () => {
    renderRow();
    expect((screen.getByTestId('svc-requiredSex-1') as HTMLSelectElement).value).toBe('F');
    expect((screen.getByTestId('svc-workSchedule-1') as HTMLSelectElement).value).toBe('part-time');
    expect((screen.getByTestId('svc-requiredExperience-1') as HTMLTextAreaElement).value).toBe('exp-sintetica');
    expect((screen.getByTestId('svc-paymentDay-1') as HTMLInputElement).value).toBe('dia 5');
    expect((screen.getByTestId('svc-workerAttributes-1') as HTMLTextAreaElement).value).toBe('atrib-sintetico');
    expect((screen.getByTestId('svc-dailyObs-1') as HTMLTextAreaElement).value).toBe('obs-sintetica');
    expect((screen.getByTestId('svc-profession-AT-1') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('svc-profession-CAREGIVER-1') as HTMLInputElement).checked).toBe(false);
  });

  it('os 4 textos livres ficam DENTRO do container mascarado do Clarity (T.3) e o dia de pago é "al prestador"', () => {
    renderRow();
    const mask = screen.getByTestId('svc-recruitment-freetext-1');
    expect(mask.getAttribute('data-clarity-mask')).toBe('True');
    for (const id of ['svc-requiredExperience-1', 'svc-paymentDay-1', 'svc-workerAttributes-1', 'svc-dailyObs-1']) {
      expect(mask.contains(screen.getByTestId(id))).toBe(true);
    }
    // o select de sexo (codificado) NÃO é texto livre: fica fora da máscara
    expect(mask.contains(screen.getByTestId('svc-requiredSex-1'))).toBe(false);
    expect(screen.getByText(/Día de pago al prestador/)).toBeTruthy();
    expect(screen.getAllByText(/No incluir información de salud del paciente/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Solo ficha: no se copia a la vacante/).length).toBe(2);
  });

  it('S.4: não existe campo de motivo do sexo (nenhum testid/id/name com "reason" ou "motivo" nesta seção)', () => {
    renderRow();
    const section = screen.getByTestId('svc-recruitment-1');
    const attrs = Array.from(section.querySelectorAll('*')).flatMap((el) => [el.getAttribute('data-testid'), el.getAttribute('id'), el.getAttribute('name')]);
    expect(attrs.filter((a) => a && /reason|motivo|sexReason/i.test(a))).toEqual([]);
    expect(attrs.some((a) => a === 'svc-requiredSex-1')).toBe(true); // controle: o instrumento enxerga o campo do sexo
    expect(screen.getByText(/El motivo no se registra/)).toBeTruthy();
  });

  it('salvar envia os 7 campos (PATCH); BOTH é aceito', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    renderRow();
    fireEvent.change(screen.getByTestId('svc-requiredSex-1'), { target: { value: 'BOTH' } });
    fireEvent.click(screen.getByTestId('svc-profession-CAREGIVER-1'));
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][2]).toMatchObject({
      requiredProfessions: ['AT', 'CAREGIVER'], requiredSex: 'BOTH', requiredExperience: 'exp-sintetica',
      workerAttributes: 'atrib-sintetico', workSchedule: 'part-time', paymentDay: 'dia 5', dailyObs: 'obs-sintetica',
    });
  });

  it('limpar os campos envia null (nunca string vazia nem lista vazia)', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    renderRow();
    fireEvent.change(screen.getByTestId('svc-requiredSex-1'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('svc-paymentDay-1'), { target: { value: '   ' } });
    fireEvent.change(screen.getByTestId('svc-dailyObs-1'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('svc-profession-AT-1'));
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    expect(mockUpdate.mock.calls[0][2]).toMatchObject({ requiredProfessions: null, requiredSex: null, paymentDay: null, dailyObs: null });
  });

  it('modo NOVO: sem preencher nada, envia os 7 como null', async () => {
    mockCreate.mockResolvedValue(SERVICE);
    renderRow(null);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][1]).toMatchObject({
      requiredProfessions: null, requiredSex: null, requiredExperience: null, workerAttributes: null, workSchedule: null, paymentDay: null, dailyObs: null,
    });
  });
});
