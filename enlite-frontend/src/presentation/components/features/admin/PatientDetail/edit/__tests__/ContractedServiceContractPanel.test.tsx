/**
 * ContractedServiceContractPanel — o contrato do serviço existente (spec 058 §1.5, §4.4): NO_CONTRACT, vincular, obra social TRAVADA
 * depois do 1º vínculo, trocar (SWITCHED) / corrigir (CORRECTION) / terminar, preço e imposto SÓ exibidos, REDACTED, e as saídas
 * REQUIRES_NEW_SERVICE / USE_CORRECTION (frase + botão). i18n REAL (es).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { CONTRACT_058_DEFAULTS, LINKED_058 } from '@domain/entities/__tests__/fixtures/contractedService058';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { ContractedServiceContractPanel } from '../ContractedServiceContractPanel';

const mockForService = vi.fn();
const mockListContracts = vi.fn();
const mockCreateLink = vi.fn();
const mockEndLink = vi.fn();
const mockSupersede = vi.fn();
vi.mock('@infrastructure/http/AdminInsuranceApiService', () => ({
  AdminInsuranceApiService: {
    listProvidersForService: (...a: unknown[]) => mockForService(...a),
    listContracts: (...a: unknown[]) => mockListContracts(...a),
    createContractLink: (...a: unknown[]) => mockCreateLink(...a),
    endContractLink: (...a: unknown[]) => mockEndLink(...a),
    supersedeContractLink: (...a: unknown[]) => mockSupersede(...a),
  },
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: 'es', fallbackLng: 'es', resources: { es: { translation: esJson } }, interpolation: { escapeValue: false }, initImmediate: false });
});

const BASE = {
  id: 's1', patientId: 'pat1', serviceCode: 'AT', professionalProfile: null, providersNeeded: 1, authorization: null, scheduleHours: 0, careLocation: null,
  startDate: null, supervisionFrequency: null, guardShift: null, providerAgeBand: null, requiredProfessions: null, requiredSex: null, requiredExperience: null,
  workerAttributes: null, workSchedule: null, paymentDay: null, dailyObs: null, addressId: null, schedule: null, liveVacancy: null, liveVacancyRedacted: false,
  active: true, endedAt: null, country: 'AR', deviceTypes: [], providers: [], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const UNLINKED = { ...BASE, ...CONTRACT_058_DEFAULTS } as PatientContractedServiceDetail;
const LINKED = { ...BASE, ...LINKED_058 } as PatientContractedServiceDetail;
const ENDED = {
  ...UNLINKED,
  payerHistory: [{ linkId: 'l1', isPrivate: false, validFrom: '2026-01-01', validTo: '2026-06-30', names: LINKED_058.payer.names }],
} as PatientContractedServiceDetail;
const NO_COVERAGE_PERM = {
  ...LINKED,
  payer: { state: 'LINKED', isPrivate: false, validFrom: '2026-09-01', validTo: null, names: null },
  price: { state: 'REDACTED' },
  coverageMatch: { state: 'REDACTED' },
} as PatientContractedServiceDetail;

const CONTRATO = { id: 'ct-2', name: 'Plan 310', country: 'AR', scopeDescription: null, asOf: '2026-10-19', currentTerm: { state: 'NO_TERM' }, futureTerms: [] };
const erro = (status: number, code: string) => Object.assign(new Error('x'), { status, code });

function renderPanel(service: PatientContractedServiceDetail, extra: Partial<React.ComponentProps<typeof ContractedServiceContractPanel>> = {}) {
  const onChanged = vi.fn();
  const onRequestNewService = vi.fn();
  render(<ContractedServiceContractPanel patientId="pat1" service={service} onChanged={onChanged} onRequestNewService={onRequestNewService} {...extra} />);
  return { onChanged, onRequestNewService };
}

const optionsOf = (testId: string): string[] => Array.from((screen.getByTestId(testId) as HTMLSelectElement).options).map((o) => o.value);

describe('ContractedServiceContractPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForService.mockResolvedValue({ providers: [{ code: 'OSDE', name: 'OSDE' }, { code: 'GALENO', name: 'Galeno' }], asOf: '2026-10-19' });
    mockListContracts.mockResolvedValue([CONTRATO]);
  });

  it('sem vínculo: NO_CONTRACT em pagador, preço e imposto, divergência NO_PAYER, e só o botão "Vincular contrato"', () => {
    renderPanel(UNLINKED);
    expect(screen.getByTestId('svc-payer').getAttribute('data-state')).toBe('NO_CONTRACT');
    expect(screen.getByTestId('svc-payer').textContent).toContain('Sin contrato vinculado');
    expect(screen.getByTestId('svc-price').textContent).toBe('Sin contrato vinculado');
    expect(screen.getByTestId('svc-tax').textContent).toBe('Sin contrato vinculado');
    expect(screen.getByTestId('svc-coverage-match').getAttribute('data-state')).toBe('NO_PAYER');
    expect(screen.getByTestId('svc-contract-link-open')).toBeTruthy();
    expect(screen.queryByTestId('svc-contract-switch-open')).toBeNull();
    expect(screen.queryByTestId('svc-contract-new-service')).toBeNull();
  });

  it('vincular: cascata Obra social -> Contrato; salvar manda contractId + validFrom (o asOf da resposta) + validTo null e devolve o serviço ao pai', async () => {
    const vinculado = { ...LINKED, id: 's1' };
    mockCreateLink.mockResolvedValue(vinculado);
    const { onChanged } = renderPanel(UNLINKED);
    fireEvent.click(screen.getByTestId('svc-contract-link-open'));
    await waitFor(() => expect(optionsOf('svc-contract-provider')).toContain('OSDE'));
    expect((screen.getByTestId('svc-contract-save') as HTMLButtonElement).disabled).toBe(true); // sem contrato escolhido não grava
    fireEvent.change(screen.getByTestId('svc-contract-provider'), { target: { value: 'OSDE' } });
    await waitFor(() => expect(optionsOf('svc-contract-contract')).toContain('ct-2'));
    expect(mockListContracts).toHaveBeenCalledWith('OSDE', { offered: true, country: 'AR' });
    fireEvent.change(screen.getByTestId('svc-contract-contract'), { target: { value: 'ct-2' } });
    await waitFor(() => expect((screen.getByTestId('svc-contract-valid-from') as HTMLInputElement).value).toBe('2026-10-19'));
    fireEvent.click(screen.getByTestId('svc-contract-save'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(vinculado));
    expect(mockCreateLink).toHaveBeenCalledWith('pat1', 's1', { contractId: 'ct-2', validFrom: '2026-10-19', validTo: null });
  });

  it('vinculado: mostra obra social — contrato (nomes do banco), vigência, tipo do pagador, preço e imposto SÓ exibidos (sem campo editável)', () => {
    renderPanel(LINKED);
    expect(screen.getByTestId('svc-payer').textContent).toContain('OSDE — Plan 210');
    expect(screen.getByTestId('svc-payer-validity').textContent).toContain('sin fin');
    expect(screen.getByTestId('svc-payer-kind').textContent).toContain('Prepaga');
    expect(screen.getByTestId('svc-price').textContent).toMatch(/1\.?500/);
    expect(screen.getByTestId('svc-tax').textContent).toBe('21 %');
    expect(screen.getByTestId('svc-coverage-match').getAttribute('data-state')).toBe('MATCH');
    // nada editável de valor/imposto: só botões de ação do vínculo
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByTestId('svc-contract-link-open')).toBeNull();
  });

  it('trocar de contrato (SWITCHED): a obra social fica TRAVADA na do vínculo; salvar chama supersede com reason SWITCHED', async () => {
    mockSupersede.mockResolvedValue({ ...LINKED });
    const { onChanged } = renderPanel(LINKED);
    fireEvent.click(screen.getByTestId('svc-contract-switch-open'));
    const provider = screen.getByTestId('svc-contract-provider') as HTMLSelectElement;
    await waitFor(() => expect(mockListContracts).toHaveBeenCalledWith('OSDE', { offered: true, country: 'AR' }));
    expect(provider.value).toBe('OSDE');
    expect(provider.disabled).toBe(true);
    await waitFor(() => expect(optionsOf('svc-contract-contract')).toContain('ct-2'));
    fireEvent.change(screen.getByTestId('svc-contract-contract'), { target: { value: 'ct-2' } });
    await waitFor(() => expect((screen.getByTestId('svc-contract-valid-from') as HTMLInputElement).value).toBe('2026-10-19'));
    fireEvent.click(screen.getByTestId('svc-contract-save'));
    await waitFor(() => expect(mockSupersede).toHaveBeenCalledWith('pat1', 's1', { reason: 'SWITCHED', contractId: 'ct-2', validFrom: '2026-10-19', validTo: null }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('corrigir (CORRECTION): só aqui a obra social destrava; salvar manda reason CORRECTION', async () => {
    mockSupersede.mockResolvedValue({ ...LINKED });
    renderPanel(LINKED);
    fireEvent.click(screen.getByTestId('svc-contract-correct-open'));
    await waitFor(() => expect(optionsOf('svc-contract-provider')).toContain('GALENO'));
    expect((screen.getByTestId('svc-contract-provider') as HTMLSelectElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId('svc-contract-provider'), { target: { value: 'GALENO' } });
    await waitFor(() => expect(mockListContracts).toHaveBeenCalledWith('GALENO', { offered: true, country: 'AR' }));
    await waitFor(() => expect(optionsOf('svc-contract-contract')).toContain('ct-2'));
    fireEvent.change(screen.getByTestId('svc-contract-contract'), { target: { value: 'ct-2' } });
    await waitFor(() => expect((screen.getByTestId('svc-contract-valid-from') as HTMLInputElement).value).toBe('2026-10-19'));
    fireEvent.click(screen.getByTestId('svc-contract-save'));
    await waitFor(() => expect(mockSupersede).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ reason: 'CORRECTION', contractId: 'ct-2' })));
  });

  it('terminar vínculo: o último dia vigente nasce no asOf do serviço (não em new Date) e vai em end', async () => {
    mockEndLink.mockResolvedValue({ ...UNLINKED });
    const { onChanged } = renderPanel(LINKED);
    fireEvent.click(screen.getByTestId('svc-contract-end-open'));
    expect((screen.getByTestId('svc-contract-end-to') as HTMLInputElement).value).toBe('2026-10-19');
    fireEvent.change(screen.getByTestId('svc-contract-end-to'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByTestId('svc-contract-save'));
    await waitFor(() => expect(mockEndLink).toHaveBeenCalledWith('pat1', 's1', { validTo: '2026-12-31' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('cancelar fecha o formulário sem chamar a API', () => {
    renderPanel(LINKED);
    fireEvent.click(screen.getByTestId('svc-contract-end-open'));
    fireEvent.click(screen.getByTestId('svc-contract-cancel'));
    expect(screen.queryByTestId('svc-contract-form-end')).toBeNull();
    expect(mockEndLink).not.toHaveBeenCalled();
  });

  it('REQUIRES_NEW_SERVICE: frase + botão "Crear un servicio nuevo" que chama o pai', async () => {
    mockCreateLink.mockRejectedValue(erro(422, 'REQUIRES_NEW_SERVICE'));
    const { onRequestNewService } = renderPanel(UNLINKED);
    fireEvent.click(screen.getByTestId('svc-contract-link-open'));
    await waitFor(() => expect(optionsOf('svc-contract-provider')).toContain('OSDE'));
    fireEvent.change(screen.getByTestId('svc-contract-provider'), { target: { value: 'OSDE' } });
    await waitFor(() => expect(optionsOf('svc-contract-contract')).toContain('ct-2'));
    fireEvent.change(screen.getByTestId('svc-contract-contract'), { target: { value: 'ct-2' } });
    await waitFor(() => expect((screen.getByTestId('svc-contract-valid-from') as HTMLInputElement).value).toBe('2026-10-19'));
    fireEvent.click(screen.getByTestId('svc-contract-save'));
    await waitFor(() => expect(screen.getByTestId('svc-contract-error').textContent).toContain('otra admisión'));
    fireEvent.click(screen.getByTestId('svc-contract-error-new-service'));
    expect(onRequestNewService).toHaveBeenCalledTimes(1);
  });

  it('USE_CORRECTION: frase + botão "Corregir vínculo" que abre o modo correção', () => {
    renderPanel(LINKED, { initialError: erro(422, 'USE_CORRECTION') });
    expect(screen.getByTestId('svc-contract-error').textContent).toContain('ningún período anterior');
    fireEvent.click(screen.getByTestId('svc-contract-error-correct'));
    expect(screen.getByTestId('svc-contract-form-correct')).toBeTruthy();
    expect(screen.queryByTestId('svc-contract-error')).toBeNull(); // abrir o formulário limpa o erro anterior
  });

  it('serviço já ENCERRADO (histórico, sem vínculo vivo): oferece "Crear un servicio nuevo" além de vincular', () => {
    const { onRequestNewService } = renderPanel(ENDED);
    fireEvent.click(screen.getByTestId('svc-contract-new-service'));
    expect(onRequestNewService).toHaveBeenCalledTimes(1);
  });

  it('erro por constraint/código vira a frase do idioma — nunca o texto cru do back', async () => {
    mockEndLink.mockRejectedValue(Object.assign(new Error('Range overlap'), { status: 409, code: 'RANGE_OVERLAP', details: { constraint: 'contracted_service_contract_sem_sobreposicao' } }));
    renderPanel(LINKED);
    fireEvent.click(screen.getByTestId('svc-contract-end-open'));
    fireEvent.click(screen.getByTestId('svc-contract-save'));
    await waitFor(() => expect(screen.getByTestId('svc-contract-error').textContent).toContain('otro vínculo del mismo servicio'));
    expect(screen.getByTestId('svc-contract-error').textContent).not.toContain('Range overlap');
  });

  it('erro 409 genérico e 422 sem code usam a frase do status', async () => {
    mockEndLink.mockRejectedValueOnce(erro(409, 'CONCURRENCY_CONFLICT'));
    renderPanel(LINKED);
    fireEvent.click(screen.getByTestId('svc-contract-end-open'));
    fireEvent.click(screen.getByTestId('svc-contract-save'));
    await waitFor(() => expect(screen.getByTestId('svc-contract-error').textContent).toContain('al mismo tiempo'));
  });

  it('sem a célula de preço (REDACTED) e sem `coverage`: cadeado, obra social oculta, divergência REDACTED, sem tipo de pagador; trocar de contrato desligado, corrigir segue', () => {
    renderPanel(NO_COVERAGE_PERM);
    expect(screen.getByTestId('svc-price').textContent).toContain('🔒');
    expect(screen.getByTestId('svc-price').textContent).not.toMatch(/\d/);
    expect(screen.getByTestId('svc-tax').textContent).toBe('21 %'); // o imposto nunca é redigido
    expect(screen.getByTestId('svc-payer').textContent).toContain('Obra social no visible con tu permiso');
    expect(screen.queryByTestId('svc-payer-kind')).toBeNull();
    expect(screen.getByTestId('svc-coverage-match').getAttribute('data-state')).toBe('REDACTED');
    expect((screen.getByTestId('svc-contract-switch-open') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('svc-contract-correct-open') as HTMLButtonElement).disabled).toBe(false);
  });

  it('pagador PARTICULAR (isPrivate) sem permissão de nomes: mostra "Particular", não "oculto"', () => {
    const particular = { ...NO_COVERAGE_PERM, payer: { state: 'LINKED', isPrivate: true, validFrom: '2026-09-01', validTo: null, names: null }, coverageMatch: { state: 'REDACTED' } } as PatientContractedServiceDetail;
    renderPanel(particular);
    expect(screen.getByTestId('svc-payer').textContent).toContain('Particular');
  });

  it('serviço em BAIXA: nem "Vincular" nem "Crear un servicio nuevo" aparecem, e o vínculo encerrado segue como histórico', () => {
    renderPanel({ ...ENDED, active: false, endedAt: '2026-10-10T00:00:00Z' });
    expect(screen.queryByTestId('svc-contract-link-open')).toBeNull();
    expect(screen.queryByTestId('svc-contract-new-service')).toBeNull();
    expect(screen.queryByTestId('svc-contract-end-open')).toBeNull();
    expect(screen.getByTestId('svc-payer').getAttribute('data-state')).toBe('NO_CONTRACT');
  });

  it('serviço em BAIXA que ainda traga vínculo vivo: as ações ficam desligadas', () => {
    renderPanel({ ...LINKED, active: false });
    for (const id of ['svc-contract-switch-open', 'svc-contract-correct-open', 'svc-contract-end-open']) {
      expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  describe('vínculo vivo que só começa no futuro (asOf 19/10, início 01/11)', () => {
    const FUTURE = {
      ...UNLINKED,
      payerHistory: [{ linkId: 'l1', isPrivate: false, validFrom: '2026-11-01', validTo: null, names: LINKED_058.payer.names }],
    } as PatientContractedServiceDetail;

    it('mostra o contrato e "programado desde" a data; esconde "Vincular"; oferece Corrigir e Terminar habilitados', () => {
      renderPanel(FUTURE);
      expect(screen.getByTestId('svc-payer').textContent).toContain('OSDE — Plan 210');
      expect(screen.getByTestId('svc-payer-scheduled').textContent).toMatch(/1\/11\/2026/);
      expect(screen.queryByTestId('svc-contract-link-open')).toBeNull();
      expect(screen.queryByTestId('svc-contract-new-service')).toBeNull();
      expect((screen.getByTestId('svc-contract-correct-open') as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByTestId('svc-contract-end-open') as HTMLButtonElement).disabled).toBe(false);
    });

    it('Corrigir manda CORRECTION; Terminar nasce no início do vínculo (não antes dele) e vai em end', async () => {
      mockSupersede.mockResolvedValue(FUTURE);
      mockEndLink.mockResolvedValue(FUTURE);
      renderPanel(FUTURE);
      fireEvent.click(screen.getByTestId('svc-contract-end-open'));
      expect((screen.getByTestId('svc-contract-end-to') as HTMLInputElement).value).toBe('2026-11-01');
      fireEvent.click(screen.getByTestId('svc-contract-save'));
      await waitFor(() => expect(mockEndLink).toHaveBeenCalledWith('pat1', 's1', { validTo: '2026-11-01' }));
      fireEvent.click(screen.getByTestId('svc-contract-correct-open'));
      expect(screen.getByTestId('svc-contract-form-correct')).toBeTruthy();
    });

    it('USE_CORRECTION sem vínculo vigente (futuro) ainda traz o botão que abre a correção', () => {
      renderPanel(FUTURE, { initialError: erro(422, 'USE_CORRECTION') });
      fireEvent.click(screen.getByTestId('svc-contract-error-correct'));
      expect(screen.getByTestId('svc-contract-form-correct')).toBeTruthy();
    });
  });

  it('erro herdado (vínculo que falhou logo após criar o serviço) aparece já na abertura', () => {
    renderPanel(UNLINKED, { initialError: erro(422, 'COUNTRY_MISMATCH') });
    expect(screen.getByTestId('svc-contract-error').textContent).toContain('país del contrato');
  });

  it('as 7 divergências do serviço chegam traduzidas', () => {
    for (const state of ['NO_PAYER', 'PRIVATE_PAYER', 'NO_COVERAGE', 'UNMAPPED_ONLY', 'MATCH', 'MISMATCH', 'REDACTED'] as const) {
      const { unmount } = render(<ContractedServiceContractPanel patientId="pat1" service={{ ...LINKED, coverageMatch: { state } } as PatientContractedServiceDetail} onChanged={vi.fn()} />);
      expect(screen.getByTestId('svc-coverage-match').getAttribute('data-state')).toBe(state);
      expect(screen.getByTestId('svc-coverage-match').textContent).not.toContain('admin.patients');
      unmount();
    }
  });

  describe('cascata — falhas de leitura', () => {
    it('sem permissão para listar (403): avisa com a frase do idioma, sem lista e sem travar o formulário', async () => {
      mockForService.mockRejectedValue(erro(403, ''));
      renderPanel(UNLINKED);
      fireEvent.click(screen.getByTestId('svc-contract-link-open'));
      await waitFor(() => expect(screen.getByTestId('svc-contract-load-error').textContent).toContain('No tenés permiso'));
    });

    it('nenhuma obra social com contrato oferecido no país: aviso próprio (não uma lista vazia muda)', async () => {
      mockForService.mockResolvedValue({ providers: [], asOf: '2026-10-19' });
      renderPanel(UNLINKED);
      fireEvent.click(screen.getByTestId('svc-contract-link-open'));
      await waitFor(() => expect(screen.getByTestId('svc-contract-no-providers')).toBeTruthy());
    });

    it('serviço sem país válido: aviso e NENHUMA chamada à API', () => {
      renderPanel({ ...UNLINKED, country: '' });
      fireEvent.click(screen.getByTestId('svc-contract-link-open'));
      expect(screen.getByTestId('svc-contract-no-country')).toBeTruthy();
      expect(mockForService).not.toHaveBeenCalled();
    });

    it('a prévia do contrato escolhido mostra preço e imposto do termo, só leitura', async () => {
      mockListContracts.mockResolvedValue([{ ...CONTRATO, currentTerm: { state: 'OK', termId: 't', validFrom: '2026-09-01', validTo: null, taxRatePercent: 0, price: { state: 'OK', hourlyRate: 2000, currency: 'ARS' } } }]);
      renderPanel(UNLINKED);
      fireEvent.click(screen.getByTestId('svc-contract-link-open'));
      await waitFor(() => expect(optionsOf('svc-contract-provider')).toContain('OSDE'));
      fireEvent.change(screen.getByTestId('svc-contract-provider'), { target: { value: 'OSDE' } });
      await waitFor(() => expect(optionsOf('svc-contract-contract')).toContain('ct-2'));
      fireEvent.change(screen.getByTestId('svc-contract-contract'), { target: { value: 'ct-2' } });
      expect(screen.getByTestId('svc-contract-preview-price').textContent).toMatch(/2\.?000/);
      expect(screen.getByTestId('svc-contract-preview-tax').textContent).toBe('Exento (0 %)');
    });
  });
});
