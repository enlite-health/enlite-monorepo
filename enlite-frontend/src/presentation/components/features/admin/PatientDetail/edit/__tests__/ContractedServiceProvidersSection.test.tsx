/**
 * ContractedServiceProvidersSection — busca+associa prestador existente, baixa (spec 013 lex C-e).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { ContractedServiceProvidersSection, runAssociateProvider } from '../ContractedServiceProvidersSection';
import type { PatientContractedServiceProvider } from '@domain/entities/PatientDetail';

const mockListWorkers = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { listWorkers: (...a: unknown[]) => mockListWorkers(...a) },
}));

const mockAssociate = vi.fn();
const mockUpdateProvider = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    associateProvider: (...a: unknown[]) => mockAssociate(...a),
    updateProvider: (...a: unknown[]) => mockUpdateProvider(...a),
  },
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

const PROVIDER: PatientContractedServiceProvider = {
  id: 'p1', serviceId: 's1', workerId: 'w1', workerName: 'Ana Fixture', weeklyHours: 10,
  active: true, endedAt: null, country: 'AR', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

describe('ContractedServiceProvidersSection', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sem prestadores: empty state', () => {
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
    expect(screen.getByTestId('providers-empty-s1')).toBeTruthy();
  });

  it('lista prestadores existentes com nome, horas e status', () => {
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[PROVIDER]} onChanged={vi.fn()} />);
    const row = screen.getByTestId('provider-row-p1');
    expect(row.textContent).toContain('Ana Fixture');
    expect(row.textContent).toContain('10');
  });

  it('busca com < 2 caracteres não chama a API', async () => {
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByTestId('provider-search-s1'), { target: { value: 'a' } });
    await waitFor(() => expect(mockListWorkers).not.toHaveBeenCalled());
  });

  it('busca com ≥ 2 caracteres chama a API e mostra os resultados; selecionar preenche o campo', async () => {
    mockListWorkers.mockResolvedValue({ data: [{ id: 'w2', worker: { name: 'Bruno Prestador' } }] });
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByTestId('provider-search-s1'), { target: { value: 'bruno' } });
    await waitFor(() => expect(screen.getByTestId('provider-hit-w2')).toBeTruthy());
    fireEvent.click(screen.getByTestId('provider-hit-w2'));
    expect((screen.getByTestId('provider-search-s1') as HTMLInputElement).value).toBe('Bruno Prestador');
  });

  it('associar: com worker selecionado, chama associateProvider e limpa a busca', async () => {
    mockListWorkers.mockResolvedValue({ data: [{ id: 'w2', name: 'Carla' }] });
    mockAssociate.mockResolvedValue({ id: 'p2' });
    const onChanged = vi.fn();
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={onChanged} />);
    fireEvent.change(screen.getByTestId('provider-search-s1'), { target: { value: 'carla' } });
    await waitFor(() => screen.getByTestId('provider-hit-w2'));
    fireEvent.click(screen.getByTestId('provider-hit-w2'));
    fireEvent.change(screen.getByTestId('provider-weekly-hours-s1'), { target: { value: '15' } });
    fireEvent.click(screen.getByTestId('provider-associate-s1'));
    await waitFor(() => expect(mockAssociate).toHaveBeenCalledWith('pat1', 's1', { workerId: 'w2', weeklyHours: 15 }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('associar sem worker selecionado: botão desabilitado, não chama a API', () => {
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
    expect(screen.getByTestId('provider-associate-s1')).toBeDisabled();
  });

  it('erro ao associar mostra mensagem, sem quebrar a tela', async () => {
    mockListWorkers.mockResolvedValue({ data: [{ id: 'w2', name: 'Dani' }] });
    mockAssociate.mockRejectedValue(new Error('boom'));
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByTestId('provider-search-s1'), { target: { value: 'dani' } });
    await waitFor(() => screen.getByTestId('provider-hit-w2'));
    fireEvent.click(screen.getByTestId('provider-hit-w2'));
    fireEvent.click(screen.getByTestId('provider-associate-s1'));
    await waitFor(() => expect(screen.getByText(/No se pudo asociar/i)).toBeTruthy());
  });

  it('dar de baixa: chama updateProvider({active:false}) e onChanged', async () => {
    mockUpdateProvider.mockResolvedValue({ id: 'p1', active: false });
    const onChanged = vi.fn();
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[PROVIDER]} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('provider-deactivate-p1'));
    await waitFor(() => expect(mockUpdateProvider).toHaveBeenCalledWith('pat1', 's1', 'p1', { active: false }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('prestador INATIVO não mostra botão de baixa', () => {
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[{ ...PROVIDER, active: false }]} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('provider-deactivate-p1')).toBeNull();
  });

  it('worker sem nome (workerName null) mostra o workerId', () => {
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[{ ...PROVIDER, workerName: null }]} onChanged={vi.fn()} />);
    expect(screen.getByTestId('provider-row-p1').textContent).toContain('w1');
  });

  it('resultado da busca sem worker.name nem name: usa o id como rótulo', async () => {
    mockListWorkers.mockResolvedValue({ data: [{ id: 'w9' }] });
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
    fireEvent.change(screen.getByTestId('provider-search-s1'), { target: { value: 'sem-nome' } });
    await waitFor(() => expect(screen.getByTestId('provider-hit-w9').textContent).toBe('w9'));
  });

  it('worker sem weeklyHours mostra "—"', () => {
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[{ ...PROVIDER, weeklyHours: null }]} onChanged={vi.fn()} />);
    expect(screen.getByTestId('provider-row-p1').textContent).toContain('—');
  });

  // ── `runAssociateProvider` (QA-caça #4): o guarda `if (!selected) return` é INALCANÇÁVEL via
  // clique simulado — o botão tem `disabled={!selected}`, e o React nunca despacha o click de um
  // elemento nativo disabled (nem forçando `disabled=false` direto no DOM: o React confere a
  // prop da fiber, não o atributo — verificado empiricamente). Testado diretamente. ────────────

  it('runAssociateProvider(null, ...): retorna sem chamar a API (branch antes inalcançável)', async () => {
    const onSuccess = vi.fn();
    const setBusy = vi.fn();
    const setError = vi.fn();
    await runAssociateProvider(null, {
      patientId: 'pat1', serviceId: 's1', weeklyHours: '10',
      setBusy, setError, errorMessage: 'erro', onSuccess,
    });
    expect(mockAssociate).not.toHaveBeenCalled();
    expect(setBusy).not.toHaveBeenCalled();
    expect(setError).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('runAssociateProvider(worker, ...): chama associateProvider e onSuccess', async () => {
    mockAssociate.mockResolvedValue({ id: 'p9' });
    const onSuccess = vi.fn();
    const setBusy = vi.fn();
    const setError = vi.fn();
    await runAssociateProvider(
      { id: 'w9', name: 'Worker Nine' },
      { patientId: 'pat1', serviceId: 's1', weeklyHours: '12', setBusy, setError, errorMessage: 'erro', onSuccess },
    );
    expect(mockAssociate).toHaveBeenCalledWith('pat1', 's1', { workerId: 'w9', weeklyHours: 12 });
    expect(setError).toHaveBeenNthCalledWith(1, null);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(setBusy).toHaveBeenNthCalledWith(1, true);
    expect(setBusy).toHaveBeenNthCalledWith(2, false);
  });
});
