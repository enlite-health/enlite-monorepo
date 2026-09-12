/**
 * PatientContractedServicesEditDrawer — lista + formulário por serviço (spec 013, bloco C).
 * Fonte de verdade é o REFETCH próprio (não `patient.contractedServices` estático), porque o
 * drawer fica aberto durante várias mutações seguidas.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { PatientContractedServicesEditDrawer } from '../PatientContractedServicesEditDrawer';
import { patientDetailFixture } from '../../__tests__/patientDetailFixture';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

const mockList = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    listContractedServices: (...a: unknown[]) => mockList(...a),
    createContractedService: vi.fn(),
    updateContractedService: vi.fn(),
    associateProvider: vi.fn(),
    updateProvider: vi.fn(),
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
  id: 's1', patientId: patientDetailFixture.id, serviceCode: 'AT', professionalProfile: null,
  providersNeeded: 2, authorizedHours: 20, weeklyHours: 20, careLocation: 'HOME',
  hourlyValue: 1500, hourlyValueRedacted: false, startDate: null,
  contractType: null, taxCondition: null, supervisionFrequency: null, guardShift: null,
  providerAgeBand: null,
  addressId: null,
  liveVacancyId: null,
  schedule: null,
  active: true, endedAt: null, country: 'AR', deviceTypes: [], providers: [],
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

describe('PatientContractedServicesEditDrawer — UM serviço por vez (Gabriel, 06/09)', () => {
  beforeEach(() => { mockList.mockReset(); vi.clearAllMocks(); });

  const api = async () => (await import('@infrastructure/http/AdminContractedServicesApiService')).AdminContractedServicesApiService;
  const montar = (target: { kind: 'new' } | { kind: 'edit'; serviceId: string }, over: Partial<Parameters<typeof PatientContractedServicesEditDrawer>[0]> = {}) =>
    render(<PatientContractedServicesEditDrawer patient={patientDetailFixture} target={target} onClose={vi.fn()} onSaved={vi.fn()} {...over} />);

  it('modo NOVO: título "Nuevo servicio contratado", só o formulário vazio — sem lista, sem botão "+ Nuevo servicio"', async () => {
    mockList.mockResolvedValue([SERVICE]);
    montar({ kind: 'new' });
    await waitFor(() => expect(mockList).toHaveBeenCalledWith(patientDetailFixture.id));
    expect(screen.getByRole('dialog', { name: 'Nuevo servicio contratado' })).toBeTruthy();
    expect(screen.getByTestId('contracted-service-new')).toBeTruthy();
    expect(screen.queryByTestId('contracted-service-form-s1')).toBeNull(); // o existente NÃO aparece
    expect(screen.queryByTestId('contracted-service-add')).toBeNull();
  });

  it('modo EDIÇÃO: busca a lista atual (não confia em patient.contractedServices estático) e mostra SÓ o serviço pedido', async () => {
    mockList.mockResolvedValue([SERVICE, { ...SERVICE, id: 's2', serviceCode: 'CAREGIVER' }]);
    montar({ kind: 'edit', serviceId: 's2' });
    await screen.findByTestId('contracted-service-form-s2');
    expect(screen.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeTruthy();
    expect(screen.queryByTestId('contracted-service-form-s1')).toBeNull();
    expect(screen.queryByTestId('contracted-service-new')).toBeNull();
    expect(screen.getByText('Servicio 2')).toBeTruthy(); // o índice é a posição na lista
  });

  it('modo EDIÇÃO com id que já não existe na lista → mensagem, sem quebrar', async () => {
    mockList.mockResolvedValue([SERVICE]);
    montar({ kind: 'edit', serviceId: 'sumiu' });
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(await screen.findByTestId('contracted-service-missing')).toBeTruthy();
  });

  it('erro ao buscar a lista mostra mensagem, sem quebrar o drawer', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    montar({ kind: 'edit', serviceId: 's1' });
    expect(await screen.findByTestId('contracted-services-load-error')).toBeTruthy();
    expect(screen.queryByTestId('contracted-service-missing')).toBeNull(); // não acusa "sumiu" por cima do erro
  });

  it('modo NOVO: cancelar no formulário fecha o drawer (é a única coisa nele)', async () => {
    mockList.mockResolvedValue([]);
    const onClose = vi.fn();
    montar({ kind: 'new' }, { onClose });
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    vi.useFakeTimers();
    fireEvent.click(screen.getByTestId('contracted-service-new-cancel'));
    act(() => { vi.advanceTimersByTime(300); });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('modo NOVO: salvar cria, refetch LOCAL, e o recém-criado (o mais novo) vira o alvo de edição — SEM chamar onSaved do pai ainda', async () => {
    const criado = { ...SERVICE, id: 'novo', createdAt: '2026-09-06T10:00:00Z' };
    mockList.mockResolvedValueOnce([SERVICE]).mockResolvedValueOnce([SERVICE, criado]);
    (await api()).createContractedService = vi.fn().mockResolvedValue(criado) as never;
    const onSaved = vi.fn();
    montar({ kind: 'new' }, { onSaved });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('svc-code-2'), { target: { value: 'AT' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await screen.findByTestId('contracted-service-form-novo');
    expect(screen.queryByTestId('contracted-service-new')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Editar servicio contratado' })).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('modo NOVO: o alvo vem do objeto que a API DEVOLVEU — se o list() seguinte falhar, o recém-criado continua na tela (edição), com aviso de recarga, NUNCA um form vazio de novo (gate 06/09)', async () => {
    const criado = { ...SERVICE, id: 'novo', createdAt: '2026-09-06T10:00:00Z' };
    mockList.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('list caiu'));
    (await api()).createContractedService = vi.fn().mockResolvedValue(criado) as never;
    montar({ kind: 'new' });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await screen.findByTestId('contracted-service-form-novo');
    expect(screen.queryByTestId('contracted-service-new')).toBeNull();
    expect(screen.getByTestId('contracted-services-load-error').textContent).toContain('El cambio se guardó');
    expect(screen.queryByTestId('contracted-service-missing')).toBeNull();
  });

  it('modo EDIÇÃO: salvar mescla o objeto devolvido na lista local (o form mostra o valor novo antes mesmo do refetch)', async () => {
    // Dois serviços na lista: o mesclado troca SÓ o seu (o outro fica como estava).
    mockList.mockResolvedValueOnce([{ ...SERVICE, id: 's0' }, SERVICE]).mockRejectedValueOnce(new Error('list caiu'));
    (await api()).updateContractedService = vi.fn().mockResolvedValue({ ...SERVICE, providersNeeded: 9 }) as never;
    montar({ kind: 'edit', serviceId: 's1' });
    await screen.findByTestId('contracted-service-form-s1');
    // s1 é o 2º da lista → o form é "Servicio 2" (índice = posição), testids terminam em -2.
    fireEvent.change(screen.getByTestId('svc-providersNeeded-2'), { target: { value: '9' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('contracted-service-form-s1')).toBeTruthy();
    expect(screen.getByTestId('svc-providersNeeded-2')).toHaveValue(9);
  });

  it('caminho sem objeto devolvido (baixa) em modo NOVO: cai no mais novo do refetch; refetch vazio não troca o alvo', async () => {
    // Simula um onSaved() sem argumento chamando o handler pelo form: a baixa não existe no form
    // novo, então o guard é exercido via refetch devolvendo lista — e via lista vazia.
    const criado = { ...SERVICE, id: 'novo', createdAt: '2026-09-06T10:00:00Z' };
    mockList.mockResolvedValueOnce([]).mockResolvedValueOnce([SERVICE, criado]);
    (await api()).createContractedService = vi.fn().mockResolvedValue(undefined) as never; // API antiga sem corpo
    montar({ kind: 'new' });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByTestId('svc-code-1'), { target: { value: 'AT' } });
    fireEvent.click(screen.getByTestId('contracted-service-new-save'));
    await screen.findByTestId('contracted-service-form-novo');

    mockList.mockReset();
    mockList.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const { unmount } = montar({ kind: 'new' });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getAllByTestId('svc-code-1')[0], { target: { value: 'AT' } });
    fireEvent.click(screen.getAllByTestId('contracted-service-new-save')[0]);
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(screen.getAllByTestId('contracted-service-new').length).toBeGreaterThan(0);
    unmount();
  });

  it('fechar DEPOIS de ter salvo algo (dirty) chama onSaved do pai — refetch da página só acontece ao sair', async () => {
    mockList.mockResolvedValue([SERVICE]);
    (await api()).updateContractedService = vi.fn().mockResolvedValue(SERVICE) as never;
    const onSaved = vi.fn(); const onClose = vi.fn();
    montar({ kind: 'edit', serviceId: 's1' }, { onSaved, onClose });
    await screen.findByTestId('contracted-service-form-s1');
    fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(onSaved).not.toHaveBeenCalled();
    vi.useFakeTimers();
    fireEvent.click(screen.getByLabelText('Cerrar'));
    expect(onSaved).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(300); });
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('fechar SEM ter salvo nada (não dirty) não chama onSaved do pai; X, Escape e backdrop fecham', async () => {
    mockList.mockResolvedValue([SERVICE]);
    for (const fechar of [
      () => fireEvent.click(screen.getByLabelText('Cerrar')),
      () => fireEvent.keyDown(document, { key: 'Escape' }),
      () => fireEvent.click(screen.getByTestId('patient-contracted-services-edit-backdrop')),
    ]) {
      const onSaved = vi.fn(); const onClose = vi.fn();
      const { unmount } = montar({ kind: 'edit', serviceId: 's1' }, { onSaved, onClose });
      await screen.findByTestId('contracted-service-form-s1');
      vi.useFakeTimers();
      fechar();
      act(() => { vi.advanceTimersByTime(300); });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onSaved).not.toHaveBeenCalled();
      vi.useRealTimers();
      unmount();
    }
  });

  describe('confirmação ao fechar com mudanças (US-D4)', () => {
    it('editar um campo de um serviço existente → backdrop abre confirmação em vez de fechar', async () => {
      mockList.mockResolvedValue([SERVICE]);
      const onClose = vi.fn();
      montar({ kind: 'edit', serviceId: 's1' }, { onClose });
      await screen.findByTestId('contracted-service-form-s1');
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '9' } });
      fireEvent.click(screen.getByTestId('patient-contracted-services-edit-backdrop'));
      expect(await screen.findByTestId('discard-changes-confirm')).toBeTruthy();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('modo NOVO sem digitar nada → Escape fecha direto (form novo ainda não é dirty)', async () => {
      mockList.mockResolvedValue([]);
      montar({ kind: 'new' });
      await waitFor(() => expect(mockList).toHaveBeenCalled());
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('discard-changes-confirm')).toBeNull();
    });

    it('digitar no NOVO → Escape abre confirmação; "Descartar" fecha de verdade', async () => {
      mockList.mockResolvedValue([]);
      const onClose = vi.fn();
      montar({ kind: 'new' }, { onClose });
      await waitFor(() => expect(mockList).toHaveBeenCalled());
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '3' } });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(await screen.findByTestId('discard-changes-confirm')).toBeTruthy();
      vi.useFakeTimers();
      fireEvent.click(screen.getByTestId('discard-changes-discard'));
      act(() => { vi.advanceTimersByTime(300); });
      expect(onClose).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it('salvar um serviço existente com sucesso volta a ficar limpo — Escape fecha direto depois', async () => {
      mockList.mockResolvedValueOnce([SERVICE]).mockResolvedValueOnce([{ ...SERVICE, providersNeeded: 5 }]);
      (await api()).updateContractedService = vi.fn().mockResolvedValue({}) as never;
      montar({ kind: 'edit', serviceId: 's1' });
      await screen.findByTestId('contracted-service-form-s1');
      fireEvent.change(screen.getByTestId('svc-providersNeeded-1'), { target: { value: '5' } });
      fireEvent.click(screen.getByTestId('contracted-service-save-s1'));
      await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
      // O "voltou a ficar limpo" é `reset()` → `useEffect([isDirty])` → `setFormDirty(false)`,
      // ciclos depois do 2º `list()` (corrida perdida no CI de prod em 06/09). Espera o dado
      // rehidratado e um flush de efeitos antes de sondar.
      await waitFor(() => expect(screen.getByTestId('svc-providersNeeded-1')).toHaveValue(5));
      await act(async () => { await Promise.resolve(); });
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByTestId('discard-changes-confirm')).toBeNull();
    });
  });
});
