/**
 * ContractedServiceFormRow — form de UM serviço contratado (spec 013, bloco C).
 * Cria (POST) quando `service` é null, atualiza (PATCH, Merge Patch) quando existe; baixa
 * (active:false, confirm). Spec 058: valor-hora/tipo/IVA saíram do formulário — o contrato é a cascata Obra social -> Contrato.
 */
import { CONTRACT_058_DEFAULTS } from '@domain/entities/__tests__/fixtures/contractedService058';
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { ContractedServiceFormRow, deactivateService } from '../ContractedServiceFormRow';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { LINKED_058 } from '@domain/entities/__tests__/fixtures/contractedService058';

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockCreateAuth = vi.fn();
const mockSupersedeAuth = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    createContractedService: (...a: unknown[]) => mockCreate(...a),
    updateContractedService: (...a: unknown[]) => mockUpdate(...a),
    createAuthorization: (...a: unknown[]) => mockCreateAuth(...a),
    supersedeAuthorization: (...a: unknown[]) => mockSupersedeAuth(...a),
  },
}));
const mockForService = vi.fn();
const mockListContracts = vi.fn();
const mockCreateLink = vi.fn();
vi.mock('@infrastructure/http/AdminInsuranceApiService', () => ({
  AdminInsuranceApiService: {
    listProvidersForService: (...a: unknown[]) => mockForService(...a),
    listContracts: (...a: unknown[]) => mockListContracts(...a),
    createContractLink: (...a: unknown[]) => mockCreateLink(...a),
    endContractLink: vi.fn(),
    supersedeContractLink: vi.fn(),
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
  providersNeeded: 2, authorization: null, scheduleHours: 20, careLocation: 'HOME',
  ...CONTRACT_058_DEFAULTS, startDate: '2026-09-01T00:00:00.000Z', supervisionFrequency: 'DAYS_30', guardShift: 'MORNING',
  providerAgeBand: 'AGE_30_45', requiredProfessions: null, requiredSex: null, requiredExperience: null, workerAttributes: null, workSchedule: null, paymentDay: null, dailyObs: null,
  addressId: null,
  liveVacancy: null, liveVacancyRedacted: false,
  schedule: null,
  active: true, endedAt: null, country: 'AR', deviceTypes: ['HOME'], providers: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

const ADDRESS_BASE = {
  addressType: 'primary', addressTypeOther: null, complement: null, displayOrder: 1, lat: null, lng: null, isPrimary: true,
  neighborhood: null, logisticsCorridor: null, accessNotes: null, country: 'AR',
};
const ADDRESSES = [
  { ...ADDRESS_BASE, id: 'addr-home', addressFormatted: 'Rua Augusta, 975 - Centro', addressRaw: null },
  { ...ADDRESS_BASE, id: 'addr-school', addressFormatted: null, addressRaw: 'Av. Cruzeiro do Sul, 1212', isPrimary: false, displayOrder: 2 },
];

const confirmSpy = vi.spyOn(window, 'confirm');

describe('ContractedServiceFormRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    confirmSpy.mockReturnValue(true);
    mockForService.mockResolvedValue({ providers: [{ code: 'OSDE', name: 'OSDE' }], asOf: '2026-10-19' });
    mockListContracts.mockResolvedValue([]);
  });

  it('modo NOVO: mostra o formulário vazio, sem seção de prestadores, com botão cancelar', () => {
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} onCancelNew={vi.fn()} />);
    expect(screen.getByTestId('contracted-service-new')).toBeTruthy();
    expect(screen.queryByTestId(/providers-section-/)).toBeNull();
    expect(screen.getByTestId('contracted-service-new-cancel')).toBeTruthy();
  });

  it('modo NOVO: cancelar chama onCancelNew', () => {
    const onCancelNew = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} onCancelNew={onCancelNew} />);
    fireEvent.click(screen.getByTestId('contracted-service-new-cancel'));
    expect(onCancelNew).toHaveBeenCalled();
  });

  it('modo NOVO: salvar chama createContractedService com o serviceCode escolhido, onSaved é chamado', async () => {
    mockCreate.mockResolvedValue(SERVICE);
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'CAREGIVER' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][0]).toBe('pat1');
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ serviceCode: 'CAREGIVER' });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  // Spec 015 (US-A6.1): franja etária solicitada do prestador — select no drawer.
  it('modo NOVO: escolher providerAgeBand e salvar envia o valor escolhido', async () => {
    mockCreate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.change(screen.getByTestId('svc-providerAgeBand-1'), { target: { value: 'AGE_30_45' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ providerAgeBand: 'AGE_30_45' });
  });

  it('modo NOVO: sem escolher providerAgeBand, envia null (nunca string vazia)', async () => {
    mockCreate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(mockCreate.mock.calls[0][1]).toMatchObject({ providerAgeBand: null });
  });

  it('modo NOVO: erro ao criar mostra mensagem', async () => {
    mockCreate.mockRejectedValue(new Error('boom'));
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await waitFor(() => expect(screen.getByTestId('contracted-service-new-error')).toBeTruthy());
  });

  it('modo EXISTENTE: pré-carrega os campos do serviço, código desabilitado (imutável)', () => {
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    expect((screen.getByTestId('svc-code-1') as HTMLSelectElement).value).toBe('AT');
    expect(screen.getByTestId('svc-code-1')).toBeDisabled();
    expect((screen.getByTestId('svc-providersNeeded-1') as HTMLInputElement).value).toBe('2');
    expect((screen.getByTestId('svc-profile-1') as HTMLTextAreaElement).value).toBe('perfil sintético');
    expect((screen.getByTestId('svc-providerAgeBand-1') as HTMLSelectElement).value).toBe('AGE_30_45');
    expect(screen.queryByTestId('providers-section-s1')).toBeNull();
  });

  it('modo EXISTENTE com linha antiga → a seção só leitura aparece', () => {
    const legacy = {
      id: 'p1', serviceId: 's1', workerId: 'w1', workerName: null, active: true, endedAt: null,
      country: 'AR', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    };
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={{ ...SERVICE, providers: [legacy] }} index={1} onSaved={vi.fn()} />);
    expect(screen.getByTestId('providers-section-s1')).toBeTruthy();
    expect(screen.getByTestId('provider-row-p1')).toBeTruthy();
    expect(screen.queryByTestId('provider-associate-s1')).toBeNull();
  });

  it('modo EXISTENTE: editar um campo e salvar chama updateContractedService (PATCH) com o serviceId', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={onSaved} />);
    fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ providersNeeded: 5 })));
    expect(mockUpdate.mock.calls[0][2]).not.toHaveProperty('weeklyHours');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('modo EXISTENTE: editar providerAgeBand e salvar chama updateContractedService com o novo valor', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-providerAgeBand-1'), { target: { value: 'AGE_45_PLUS' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ providerAgeBand: 'AGE_45_PLUS' })));
  });

  it('spec 058: NÃO existe mais valor-hora, tipo de contratação nem IVA editáveis no formulário (saíram do fio)', () => {
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    for (const id of ['svc-hourlyValue-1', 'svc-contractType-1', 'svc-taxCondition-1']) expect(screen.queryByTestId(id)).toBeNull();
  });

  it('spec 058: o PATCH do serviço nunca manda as chaves legadas (o back as recusa com 422 LEGACY_FIELD_REMOVED)', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
    const body = mockUpdate.mock.calls[0][2];
    for (const legacy of ['hourlyValue', 'contractType', 'taxCondition']) expect(Object.keys(body)).not.toContain(legacy);
  });

  it('modo EXISTENTE: limpar um campo numérico envia null (nunca NaN)', async () => {
    mockUpdate.mockResolvedValue(SERVICE);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', expect.objectContaining({ providersNeeded: null })));
  });

  it('modo EXISTENTE: "Dar de baja" pede confirmação; confirmando, chama updateContractedService({active:false})', async () => {
    mockUpdate.mockResolvedValue({ ...SERVICE, active: false });
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('contracted-service-deactivate-s1'));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', { active: false }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('modo EXISTENTE: "Dar de baja" cancelado no confirm NÃO chama a API', () => {
    confirmSpy.mockReturnValue(false);
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('contracted-service-deactivate-s1'));
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('modo EXISTENTE: serviço já INATIVO não mostra o botão "Dar de baja", mostra o rótulo de baixa', () => {
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={{ ...SERVICE, active: false }} index={1} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('contracted-service-deactivate-s1')).toBeNull();
    expect(screen.getByText(/Dado de baja/i)).toBeTruthy();
  });

  it('modo EXISTENTE: erro ao atualizar mostra mensagem', async () => {
    mockUpdate.mockRejectedValue(new Error('boom'));
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(screen.getByTestId('contracted-service-error-s1')).toBeTruthy());
  });

  /**
   * F4 (gate `revisao-pr`, MÉDIO ×3) — `deactivateService` tinha `try/finally` SEM `catch`. O
   * componente TEM canal de erro (`setError`, renderizado ao lado do botão Salvar) que este
   * caminho nunca usava: a operadora confirmava a baixa do serviço, o PATCH falhava, e o único
   * sinal era o spinner parando. Ela acreditava ter dado baixa.
   */
  it('F4: "Dar de baja" que FALHA usa o canal de erro que já existe no componente', async () => {
    confirmSpy.mockReturnValue(true);
    mockUpdate.mockRejectedValue(new Error('HTTP 500'));
    const onSaved = vi.fn();
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('contracted-service-deactivate-s1'));
    await waitFor(() => expect(screen.getByTestId('contracted-service-error-s1')).toBeTruthy());
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('sem data-testid de cancelar quando onCancelNew não é passado (não-novo)', () => {
    render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
    expect(screen.queryByTestId('contracted-service-new-cancel')).toBeNull();
  });

  // ── `deactivateService` (QA-caça #4): o guarda `if (!service) return` é INALCANÇÁVEL via
  // clique simulado — o botão que o chama só existe no DOM quando `service` já é não-null (ver
  // docblock da função). Testado diretamente, sem renderizar nada. ────────────────────────────

  it('deactivateService(null, ...): retorna sem confirmar, sem chamar a API (branch antes inalcançável)', async () => {
    const onSaved = vi.fn();
    const setBusy = vi.fn();
    await deactivateService(null, { patientId: 'pat1', confirmMessage: 'confirma?', setBusy, setError: vi.fn(), errorMessage: 'erro', onSaved });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('F4: deactivateService com a API falhando reporta pelo `setError` e NÃO chama onSaved', async () => {
    confirmSpy.mockReturnValue(true);
    mockUpdate.mockRejectedValue(new Error('boom'));
    const onSaved = vi.fn();
    const setBusy = vi.fn();
    const setError = vi.fn();
    await deactivateService(SERVICE, {
      patientId: 'pat1', confirmMessage: 'confirma?', setBusy, setError,
      errorMessage: 'no se pudo dar de baja', onSaved,
    });
    expect(setError).toHaveBeenLastCalledWith('no se pudo dar de baja');
    expect(onSaved).not.toHaveBeenCalled();
    expect(setBusy).toHaveBeenNthCalledWith(2, false);
  });

  it('deactivateService(SERVICE, ...): confirmando, chama updateContractedService({active:false}) e onSaved', async () => {
    confirmSpy.mockReturnValue(true);
    mockUpdate.mockResolvedValue({});
    const onSaved = vi.fn();
    const setBusy = vi.fn();
    await deactivateService(SERVICE, { patientId: 'pat1', confirmMessage: 'confirma?', setBusy, setError: vi.fn(), errorMessage: 'erro', onSaved });
    expect(confirmSpy).toHaveBeenCalledWith('confirma?');
    expect(mockUpdate).toHaveBeenCalledWith('pat1', 's1', { active: false });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setBusy).toHaveBeenNthCalledWith(2, false);
  });

  // ── Spec 014 US-D4 (lex D4 AUTORIZADO): a linha avisa o pai quando fica dirty ───────────
  describe('onDirtyChange (US-D4)', () => {
    it('editar um campo chama onDirtyChange(true)', () => {
      const onDirtyChange = vi.fn();
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} onDirtyChange={onDirtyChange} />);
      onDirtyChange.mockClear();
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '7' } });
      expect(onDirtyChange).toHaveBeenCalledWith(true);
    });

    it('salvar com sucesso volta a chamar onDirtyChange(false) — o form fica limpo de novo', async () => {
      mockUpdate.mockResolvedValue({ ...SERVICE });
      const onDirtyChange = vi.fn();
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} onDirtyChange={onDirtyChange} />);
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '7' } });
      expect(onDirtyChange).toHaveBeenCalledWith(true);
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
    });

    it('sem onDirtyChange (prop opcional ausente) não quebra ao editar', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '7' } });
    });
  });

  // ── Migration 330 (decisão do Gabriel 05/09): endereço (ponteiro) e horário do encuadre ────
  describe('endereço e horário (migration 330)', () => {
    it('o select "Domicilio" lista SÓ os endereços da ficha, com o rótulo do geocoder ou o texto cru', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      const select = screen.getByTestId('svc-addressId-1') as HTMLSelectElement;
      const labels = Array.from(select.options).map((o) => o.textContent);
      expect(labels).toContain('Rua Augusta, 975 - Centro');
      expect(labels).toContain('Av. Cruzeiro do Sul, 1212');
      expect(select.disabled).toBe(false);
    });

    it('sem endereço na ficha: o select fica desabilitado E um aviso âmbar diz que o paciente NÃO tem domicílio (Gabriel, 06/09)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={[]} service={null} index={1} onSaved={vi.fn()} />);
      expect((screen.getByTestId('svc-addressId-1') as HTMLSelectElement).disabled).toBe(true);
      const aviso = screen.getByTestId('svc-address-none-1');
      expect(aviso).toHaveAttribute('role', 'alert');
      expect(aviso.textContent).toContain('no tiene domicilio cargado');
    });

    it('com endereço na ficha: sem o aviso âmbar; o campo ocupa a linha inteira (col-span-2)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      expect(screen.queryByTestId('svc-address-none-1')).toBeNull();
      const campo = screen.getByTestId('svc-addressId-1').closest('.sm\\:col-span-2');
      expect(campo).not.toBeNull();
    });

    // ── Aviso de horário (decisão do Gabriel 07/09) ──────────────────────────────────────────
    it('serviço SEM horário: aviso âmbar role=alert diz que o paciente não vai poder mudar de status', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      const aviso = screen.getByTestId('svc-schedule-none-1');
      expect(aviso).toHaveAttribute('role', 'alert');
      expect(aviso.textContent).toContain('todavía no tiene horario');
      expect(aviso.textContent).toContain('activo, búsqueda ni reemplazo');
      expect(aviso.className).toContain('amber');
    });

    it('serviço COM horário: o aviso âmbar some', () => {
      const svc = { ...SERVICE, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00', durationMinutes: 240 }] };
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={svc} index={1} onSaved={vi.fn()} />);
      expect(screen.queryByTestId('svc-schedule-none-1')).toBeNull();
    });

    it('o campo de horário segue OPCIONAL — sem asterisco, e Guardar continua funcionando com ele vazio', async () => {
      mockCreate.mockResolvedValue({ ...SERVICE, id: 's-novo' });
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      // o rótulo diz "(opcional)", não "*" — salvar sem horário continua permitido (D283 item 4).
      // Busca pelo `for` do campo: "Horarios" também é o cabeçalho da coluna na tabela.
      const label = document.querySelector('label[for="svc-schedule-1"]');
      expect(label?.textContent).toContain('Horarios');
      expect(label?.textContent).toContain('(opcional)');
      expect(label?.querySelector('.text-red-500')).toBeNull();

      fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][1]).toMatchObject({ schedule: null });
    });

    it('a dica do campo avisa a CONSEQUÊNCIA (não diz mais "completar depois" sem ressalva)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      const dica = screen.getByText(/Opcional para guardar/);
      expect(dica.textContent).toContain('no puede pasar a activo, búsqueda ni reemplazo');
    });

    it('a dica "Solo números" fica ABAIXO do campo (hintBelow) — rótulo → campo → dica, para as colunas alinharem (gate 06/09)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      const precede = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      for (const id of ['svc-providersNeeded-1']) {
        const campo = screen.getByTestId(id);
        const label = document.querySelector(`label[for="${id}"]`) as HTMLElement;
        const raiz = label.parentElement as HTMLElement; // o FormField
        const dica = Array.from(raiz.querySelectorAll('span')).find((el) => el.textContent === 'Solo números') as HTMLElement;
        expect(dica).toBeTruthy();
        expect(precede(label, campo)).toBe(true);
        expect(precede(campo, dica)).toBe(true); // dica DEPOIS do campo
      }
      // O domicílio também: a dica vem depois do select.
      const dom = screen.getByTestId('svc-addressId-1');
      const dica = Array.from((document.querySelector('label[for="svc-addressId-1"]')!.parentElement as HTMLElement).querySelectorAll('span'))
        .find((el) => el.textContent?.startsWith('Dónde se presta')) as HTMLElement;
      expect(precede(dom, dica)).toBe(true);
    });

    it('vírgula num campo numérico é BLOQUEADA com aviso próprio (Chromium descartava e o valor ficava 100× maior)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      const ev = fireEvent.keyDown(screen.getByTestId('svc-providersNeeded-1'), { key: ',' });
      expect(ev).toBe(false); // preventDefault
      expect(screen.getByText('Para decimales usá punto (.), no coma.')).toBeTruthy();
    });

    it('onSaved recebe o serviço que a API devolveu (create e update)', async () => {
      const criado = { ...SERVICE, id: 'novo' };
      mockCreate.mockResolvedValue(criado);
      const onSaved = vi.fn();
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={onSaved} />);
      fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(criado));
      const atualizado = { ...SERVICE, providersNeeded: 9 };
      mockUpdate.mockResolvedValue(atualizado);
      const onSaved2 = vi.fn();
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={2} onSaved={onSaved2} />);
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(onSaved2).toHaveBeenCalledWith(atualizado));
    });

    it('campos numéricos avisam ao receber letra (NumericField no único que sobrou: prestadores)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      for (const id of ['svc-providersNeeded-1']) {
        fireEvent.keyDown(screen.getByTestId(id), { key: 'a' });
      }
      expect(screen.getAllByText('Este campo acepta solo números.')).toHaveLength(1);
      expect(screen.getAllByText('Solo números')).toHaveLength(1);
    });

    it('modo NOVO: escolher o endereço envia addressId; sem escolher envia null (nunca string vazia)', async () => {
      mockCreate.mockResolvedValue(SERVICE);
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][1]).toMatchObject({ addressId: null, schedule: null });

      mockCreate.mockClear();
      fireEvent.change(screen.getByTestId('svc-addressId-1'), { target: { value: 'addr-school' } });
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      expect(mockCreate.mock.calls[0][1]).toMatchObject({ addressId: 'addr-school' });
    });

    it('modo EXISTENTE: hidrata o endereço e o horário do serviço; trocar o endereço e salvar envia o novo addressId', async () => {
      mockUpdate.mockResolvedValue(SERVICE);
      const svc = { ...SERVICE, addressId: 'addr-home', schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00', durationMinutes: 240 }] };
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={svc} index={1} onSaved={vi.fn()} />);
      expect((screen.getByTestId('svc-addressId-1') as HTMLSelectElement).value).toBe('addr-home');
      // O editor de turnos (spec 056) mostra o turno hidratado na segunda-feira (dayOfWeek 1).
      expect(screen.getByTestId('svc-shift-remove-1-1-0')).toBeTruthy();

      fireEvent.change(screen.getByTestId('svc-addressId-1'), { target: { value: 'addr-school' } });
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      expect(mockUpdate.mock.calls[0][2]).toMatchObject({
        addressId: 'addr-school',
        schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }],
      });
    });

    it('modo EXISTENTE: serviço cujo endereço foi arquivado (fora da ficha) mostra o select vazio — e salvar sem escolher envia null', async () => {
      mockUpdate.mockResolvedValue(SERVICE);
      const svc = { ...SERVICE, addressId: 'addr-arquivado' };
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={svc} index={1} onSaved={vi.fn()} />);
      const select = screen.getByTestId('svc-addressId-1') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).not.toContain('addr-arquivado');
      fireEvent.change(select, { target: { value: '' } });
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      expect(mockUpdate.mock.calls[0][2]).toMatchObject({ addressId: null });
    });

    it('adicionar um turno no editor e salvar envia {dayOfWeek, startTime, durationMinutes}', async () => {
      mockUpdate.mockResolvedValue(SERVICE);
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      // O editor expõe um "+" por dia; domingo é dayOfWeek 0 e nasce 09:00-17:00 (480 min).
      fireEvent.click(screen.getByTestId('svc-shift-add-1-0'));
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      const sent = mockUpdate.mock.calls[0][2].schedule;
      expect(Array.isArray(sent)).toBe(true);
      expect(sent[0]).toEqual({ dayOfWeek: 0, startTime: '09:00', durationMinutes: 480 });
    });

    it('submit envia durationMinutes 720 (20:00 → 08:00), sem endTime', async () => {
      mockUpdate.mockResolvedValue(SERVICE);
      const svc = { ...SERVICE, schedule: [{ dayOfWeek: 2, startTime: '20:00', endTime: '08:00', durationMinutes: 720 }] };
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={svc} index={1} onSaved={vi.fn()} />);
      expect(screen.getByTestId('svc-shift-duration-1-2-0').textContent).toContain('12 h');
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      expect(mockUpdate.mock.calls[0][2].schedule).toEqual([{ dayOfWeek: 2, startTime: '20:00', durationMinutes: 720 }]);
    });

    it('Fin = Inicio bloqueia o Guardar', () => {
      const svc = { ...SERVICE, schedule: [{ dayOfWeek: 2, startTime: '20:00', endTime: '20:00', durationMinutes: 720 }] };
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={svc} index={1} onSaved={vi.fn()} />);
      expect(screen.getByTestId('svc-shift-error-1-2-0')).toBeTruthy();
      expect(screen.getByTestId('contracted-service-save-s1')).toBeDisabled();
    });

    it('409 SLOT_OVERLAP mostra svc-schedule-overlap-1', async () => {
      mockUpdate.mockRejectedValue(Object.assign(new Error('overlap'), { status: 409, code: 'SLOT_OVERLAP' }));
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      expect((await screen.findByTestId('svc-schedule-overlap-1')).textContent).toContain('se superponen');
    });

    it.each([['PROVIDERS_NEEDED_BELOW_OCCUPANCY', 'por debajo de los ya asignados'], ['PROVIDERS_NEEDED_CANNOT_CLEAR', 'no puede quedar vacía']])('422 %s mostra a mensagem própria em contracted-service-error-s1 (não a genérica)', async (code, trecho) => {
      mockUpdate.mockRejectedValue(Object.assign(new Error('x'), { status: 422, code }));
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      const erro = await screen.findByTestId('contracted-service-error-s1');
      expect(erro.textContent).toContain(trecho);
      expect(erro.textContent).not.toContain('No se pudo actualizar');
    });

    it.each([['LIVE_VACANCY', 'el servicio tiene una vacante activa'], ['ALLOCATION', 'prestadores asignados']])('REGRA-05: 422 SERVICE_ADDRESS_LOCKED (%s) → mensagem na linha do Guardar, select volta ao endereço SALVO, sem o erro genérico', async (reason, trecho) => {
      mockUpdate.mockRejectedValue(Object.assign(new Error('x'), { status: 422, code: 'SERVICE_ADDRESS_LOCKED', details: { reason } }));
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={{ ...SERVICE, addressId: 'addr-home' }} index={1} onSaved={vi.fn()} />);
      const select = screen.getByTestId('svc-addressId-1') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'addr-school' } });
      expect(select.value).toBe('addr-school');
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      const msg = await screen.findByTestId('svc-address-locked-1');
      expect(msg.textContent).toContain(trecho);
      // O que o usuário vê: a mensagem está na MESMA linha do botão Guardar (não lá em cima, sob o select).
      expect(msg.parentElement).toBe(screen.getByTestId('contracted-service-save-s1').parentElement);
      await waitFor(() => expect(select.value).toBe('addr-home'));
      expect(screen.queryByTestId('contracted-service-error-s1')).toBeNull();
    });

    it('422 SERVICE_ADDRESS_LOCKED sem endereço salvo → select volta ao vazio', async () => {
      mockUpdate.mockRejectedValue(Object.assign(new Error('x'), { status: 422, code: 'SERVICE_ADDRESS_LOCKED', details: { reason: 'LIVE_VACANCY' } }));
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      const select = screen.getByTestId('svc-addressId-1') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: 'addr-school' } });
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await screen.findByTestId('svc-address-locked-1');
      await waitFor(() => expect(select.value).toBe(''));
    });

    it.each([
      ['providers_needed', 'No se puede dejar vacía la cantidad de prestadores'],
      ['schedule', 'No se puede dejar vacío este dato'],
      [undefined, 'No se puede dejar vacío este dato'],
    ])('422 SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY (campo %s) → mensagem específica, não a genérica', async (field, trecho) => {
      mockUpdate.mockRejectedValue(Object.assign(new Error('x'), { status: 422, code: 'SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY', details: field ? { field } : undefined }));
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '' } });
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      const erro = await screen.findByTestId('contracted-service-error-s1');
      expect(erro.textContent).toContain(trecho);
      expect(erro.textContent).toContain('vacante activa');
      expect(erro.textContent).not.toContain('No se pudo actualizar');
    });

    it('REGRA-05: reason ALLOCATION → mensagem dos prestadores asignados', async () => {
      mockUpdate.mockRejectedValue(Object.assign(new Error('x'), { status: 422, code: 'SERVICE_ADDRESS_LOCKED', details: { reason: 'ALLOCATION' } }));
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      expect((await screen.findByTestId('svc-address-locked-1')).textContent).toContain('prestadores asignados');
    });

    it('REGRA-05: um novo envio bem-sucedido limpa a mensagem', async () => {
      mockUpdate.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 422, code: 'SERVICE_ADDRESS_LOCKED', details: { reason: 'ALLOCATION' } }));
      mockUpdate.mockResolvedValueOnce(SERVICE);
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await screen.findByTestId('svc-address-locked-1');
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(screen.queryByTestId('svc-address-locked-1')).toBeNull());
    });
  });

  describe('bloco Autorización (spec 056 T2.5)', () => {
    const AUTH = { id: 'a1', hours: 40, validFrom: '2026-10-01', validTo: '2026-10-31' };
    const fill = (hours: string, from: string, to: string) => {
      fireEvent.change(screen.getByTestId('svc-auth-hours-1'), { target: { value: hours } });
      fireEvent.change(screen.getByTestId('svc-auth-from-1'), { target: { value: from } });
      fireEvent.change(screen.getByTestId('svc-auth-to-1'), { target: { value: to } });
    };

    it('o NumericField authorizedHours saiu', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      expect(screen.queryByTestId('svc-authorizedHours-1')).toBeNull();
    });

    it('mostra a vigente em svc-auth-current', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={{ ...SERVICE, authorization: AUTH }} index={1} onSaved={vi.fn()} />);
      expect(screen.getByTestId('svc-auth-current-1').textContent).toContain('Vigente: 40 h del 2026-10-01 al 2026-10-31');
      expect(screen.queryByTestId('svc-auth-legacy-1')).toBeNull();
    });

    it('sem legado: authorization null mostra "sin autorización" e NÃO o valor antigo da coluna', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={{ ...SERVICE, legacyAuthorizedHours: 20 } as PatientContractedServiceDetail} index={1} onSaved={vi.fn()} />);
      expect(screen.getByTestId('svc-auth-none-1').textContent).toBe('Sin autorización vigente');
      expect(screen.queryByTestId('svc-auth-legacy-1')).toBeNull();
      expect(screen.queryByText(/Valor anterior/)).toBeNull();
      expect(screen.queryByTestId('svc-auth-current-1')).toBeNull();
    });

    it('salvar chama createAuthorization com validTo inclusivo', async () => {
      mockCreateAuth.mockResolvedValue({ ...AUTH, id: 'a2', hours: 30, validFrom: '2026-11-01', validTo: '2026-11-30' });
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      fill('30', '2026-11-01', '2026-11-30');
      fireEvent.click(screen.getByTestId('svc-auth-save-1'));
      await waitFor(() => expect(mockCreateAuth).toHaveBeenCalledWith('pat1', 's1', { hours: 30, validFrom: '2026-11-01', validTo: '2026-11-30' }));
      expect((await screen.findByTestId('svc-auth-current-1')).textContent).toContain('30 h');
      expect(mockSupersedeAuth).not.toHaveBeenCalled();
    });

    it('com vigente, salvar chama supersedeAuthorization', async () => {
      mockSupersedeAuth.mockResolvedValue({ ...AUTH, id: 'a2', hours: 50 });
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={{ ...SERVICE, authorization: AUTH }} index={1} onSaved={vi.fn()} />);
      fill('50', '2026-10-01', '2026-10-31');
      fireEvent.click(screen.getByTestId('svc-auth-save-1'));
      await waitFor(() => expect(mockSupersedeAuth).toHaveBeenCalledWith('pat1', 's1', 'a1', { hours: 50, validFrom: '2026-10-01', validTo: '2026-10-31' }));
      expect(mockCreateAuth).not.toHaveBeenCalled();
    });

    it('409 mostra overlaps', async () => {
      mockCreateAuth.mockRejectedValue(Object.assign(new Error('x'), { status: 409, code: 'AUTHORIZATION_OVERLAPS' }));
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      fill('30', '2026-11-01', '2026-11-30');
      fireEvent.click(screen.getByTestId('svc-auth-save-1'));
      expect((await screen.findByTestId('svc-auth-error-1')).textContent).toContain('Ya hay una autorización vigente que se superpone');
    });

    it('422 mostra needsEnd', async () => {
      mockCreateAuth.mockRejectedValue(Object.assign(new Error('x'), { status: 422, code: 'AUTHORIZATION_NEEDS_END' }));
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      fill('30', '2026-11-01', '2026-11-30');
      fireEvent.click(screen.getByTestId('svc-auth-save-1'));
      expect((await screen.findByTestId('svc-auth-error-1')).textContent).toContain('necesita fecha de fin');
    });
  });

  describe('total do horário (spec 056 T3.6)', () => {
    it('não existe svc-weeklyHours-*; total muda ao trocar o Fin', () => {
      const svc = { ...SERVICE, schedule: [{ dayOfWeek: 2, startTime: '08:00', endTime: '16:00', durationMinutes: 480 }, { dayOfWeek: 3, startTime: '08:00', endTime: '16:00', durationMinutes: 480 }] };
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={svc} index={1} onSaved={vi.fn()} />);
      expect(screen.queryByTestId('svc-weeklyHours-1')).toBeNull();
      expect(screen.getByTestId('svc-schedule-total-1').textContent).toBe('Total del horario: 16 h por semana');
      fireEvent.click(screen.getByTestId('svc-shift-end-1-2-0'));
      fireEvent.click(screen.getByTestId('svc-shift-end-1-2-0-option-12:00'));
      expect(screen.getByTestId('svc-schedule-total-1').textContent).toBe('Total del horario: 12 h por semana');
    });
  });

  // ── Spec 058: serviço NOVO escolhe Obra social -> Contrato; o vínculo é gravado depois de criar o serviço ─────────────
  describe('serviço novo + cascata (spec 058)', () => {
    const CONTRATO = { id: 'ct-1', name: 'Plan 210', country: 'AR', scopeDescription: null, asOf: '2026-10-19', currentTerm: { state: 'NO_TERM' }, futureTerms: [] };

    async function escolherContrato(): Promise<void> {
      await waitFor(() => expect(mockForService).toHaveBeenCalled());
      await waitFor(() => expect(Array.from((screen.getByTestId('svc-contract-1-provider') as HTMLSelectElement).options).map((o) => o.value)).toContain('OSDE'));
      fireEvent.change(screen.getByTestId('svc-contract-1-provider'), { target: { value: 'OSDE' } });
      await waitFor(() => expect(Array.from((screen.getByTestId('svc-contract-1-contract') as HTMLSelectElement).options).map((o) => o.value)).toContain('ct-1'));
      fireEvent.change(screen.getByTestId('svc-contract-1-contract'), { target: { value: 'ct-1' } });
    }

    it('as obras sociais vêm do banco pelo país do PACIENTE (nome do banco, sem tradução por código) e o início sugerido é o asOf da resposta', async () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} patientCountry="AR" onSaved={vi.fn()} />);
      await waitFor(() => expect(mockForService).toHaveBeenCalledWith('AR', undefined));
      await waitFor(() => expect((screen.getByTestId('svc-contract-1-valid-from') as HTMLInputElement).value).toBe('2026-10-19'));
      const labels = Array.from((screen.getByTestId('svc-contract-1-provider') as HTMLSelectElement).options).map((o) => o.textContent);
      expect(labels).toContain('OSDE');
    });

    it('escolher a obra social lista só os contratos OFERECIDOS dela no país; trocar a obra social zera o contrato', async () => {
      mockListContracts.mockResolvedValue([CONTRATO]);
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} patientCountry="AR" onSaved={vi.fn()} />);
      await escolherContrato();
      expect(mockListContracts).toHaveBeenCalledWith('OSDE', { offered: true, country: 'AR' });
      fireEvent.change(screen.getByTestId('svc-contract-1-provider'), { target: { value: '' } });
      await waitFor(() => expect((screen.getByTestId('svc-contract-1-contract') as HTMLSelectElement).value).toBe(''));
    });

    it('salvar com contrato: cria o serviço (SEM valor/tipo/IVA) e DEPOIS grava o vínculo; onSaved recebe o serviço vinculado', async () => {
      mockListContracts.mockResolvedValue([CONTRATO]);
      const criado = { ...SERVICE, id: 'novo' };
      const vinculado = { ...criado, ...LINKED_058 };
      mockCreate.mockResolvedValue(criado);
      mockCreateLink.mockResolvedValue(vinculado);
      const onSaved = vi.fn();
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} patientCountry="AR" onSaved={onSaved} />);
      fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
      await escolherContrato();
      await waitFor(() => expect((screen.getByTestId('svc-contract-1-valid-from') as HTMLInputElement).value).toBe('2026-10-19'));
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(vinculado));
      expect(Object.keys(mockCreate.mock.calls[0][1])).not.toEqual(expect.arrayContaining(['hourlyValue']));
      expect(mockCreateLink).toHaveBeenCalledWith('pat1', 'novo', { contractId: 'ct-1', validFrom: '2026-10-19', validTo: null });
      expect(mockCreate.mock.invocationCallOrder[0]).toBeLessThan(mockCreateLink.mock.invocationCallOrder[0]);
    });

    it('salvar SEM obra social: cria o serviço e não toca o vínculo (a carga pode vir depois)', async () => {
      mockCreate.mockResolvedValue({ ...SERVICE, id: 'novo' });
      const onSaved = vi.fn();
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} patientCountry="AR" onSaved={onSaved} />);
      fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(mockCreateLink).not.toHaveBeenCalled();
    });

    it('obra social escolhida sem contrato: NÃO cria o serviço pela metade — mostra o erro do formulário', async () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} patientCountry="AR" onSaved={vi.fn()} />);
      fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
      await waitFor(() => expect(Array.from((screen.getByTestId('svc-contract-1-provider') as HTMLSelectElement).options).map((o) => o.value)).toContain('OSDE'));
      fireEvent.change(screen.getByTestId('svc-contract-1-provider'), { target: { value: 'OSDE' } });
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(screen.getByTestId('contracted-service-new-error').textContent).toContain('Elegí el contrato'));
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('o serviço foi criado mas o VÍNCULO falhou: onSaved recebe o serviço criado + o linkError (nada se perde em silêncio)', async () => {
      mockListContracts.mockResolvedValue([CONTRATO]);
      const criado = { ...SERVICE, id: 'novo' };
      mockCreate.mockResolvedValue(criado);
      const erro = Object.assign(new Error('x'), { code: 'COUNTRY_MISMATCH', status: 422 });
      mockCreateLink.mockRejectedValue(erro);
      const onSaved = vi.fn();
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} patientCountry="AR" onSaved={onSaved} />);
      fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
      await escolherContrato();
      await waitFor(() => expect((screen.getByTestId('svc-contract-1-valid-from') as HTMLInputElement).value).toBe('2026-10-19'));
      fireEvent.click(screen.getByTestId('contracted-service-new-save'));
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith(criado, { linkError: erro }));
    });

    it('sem país (paciente sem país): a cascata não chama a API e avisa', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      expect(screen.getByTestId('svc-contract-1-no-country')).toBeTruthy();
      expect(mockForService).not.toHaveBeenCalled();
    });

    it('serviço EXISTENTE mostra o painel de contrato (não a cascata solta) — o vínculo tem botões próprios', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      expect(screen.getByTestId('svc-contract-panel-s1')).toBeTruthy();
      expect(screen.queryByTestId('svc-contract-1-cascade')).toBeNull();
    });
    it('serviço EXISTENTE: o bloco de obra social vem ANTES do campo "Servicio" (opção A: o que vale hoje sobe para o topo)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      const panel = screen.getByTestId('svc-contract-panel-s1');
      const servico = screen.getByTestId('svc-code-1');
      expect(panel.compareDocumentPosition(servico) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('serviço NOVO: a cascata continua ABAIXO do campo "Servicio" (onde sempre esteve)', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={null} index={1} onSaved={vi.fn()} />);
      const servico = screen.getByTestId('svc-code-1');
      const cascata = screen.getByTestId('svc-contract-new-1');
      expect(servico.compareDocumentPosition(cascata) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('T1: o rótulo de campo do drawer é o compacto (12px), em campos de grade, de recrutamento e de autorização', () => {
      render(<ContractedServiceFormRow patientId="pat1" addresses={ADDRESSES} service={SERVICE} index={1} onSaved={vi.fn()} />);
      for (const forId of ['svc-code-1', 'svc-providersNeeded-1', 'svc-requiredSex-1', 'svc-auth-hours-1', 'svc-profile-1']) {
        const label = document.querySelector(`label[for="${forId}"]`);
        expect(label, forId).not.toBeNull();
        expect(label!.className, forId).toContain('text-[12px]');
        expect(label!.className, forId).not.toContain('text-[18px]');
      }
    });
  });
});
