/**
 * ContractedServiceProvidersSection — busca+associa prestador existente, baixa (spec 013 lex C-e).
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

  /**
   * F4 (gate `revisao-pr`, MÉDIO ×3) — `deactivate` tinha `try/finally` SEM `catch`. Desassociar
   * prestador é ação destrutiva que a operadora confirma e acredita ter concluído; o `error` já
   * existe neste componente e é usado pelo caminho de sucesso ao lado (o associate), mas este
   * caminho nunca o usava. Falha em silêncio: o spinner para e nada mais.
   */
  it('F4: desassociar prestador que FALHA usa o canal de erro que já existe — e não avisa o pai', async () => {
    mockUpdateProvider.mockRejectedValue(new Error('HTTP 500'));
    const onChanged = vi.fn();
    render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[PROVIDER]} onChanged={onChanged} />);
    fireEvent.click(screen.getByTestId('provider-deactivate-p1'));
    await waitFor(() => expect(screen.getByText(/No se pudo dar de baja/i)).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalled();
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

  // ── F2: corrida na busca de prestador. `runSearch` disparava um `listWorkers` POR TECLA, sem
  // debounce, sem id de requisição e sem `catch`. Duas formas de a operadora associar o cuidador
  // ERRADO — e `associateProvider` manda o `workerId` sem passo de confirmação. O padrão certo já
  // existe no MESMO PR (`IcdSearchCombobox`: id de requisição + descarte no `then` E no `catch`).
  // ──────────────────────────────────────────────────────────────────────────────────────────
  describe('F2 — busca de prestador não pode entregar o resultado da consulta ERRADA', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function deferred<T>() {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    }

    it('resposta ATRASADA de "Mar" não pode sobrescrever a lista já respondida de "Marta"', async () => {
      const first = deferred<{ data: unknown[] }>();
      const second = deferred<{ data: unknown[] }>();
      mockListWorkers.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
      const input = screen.getByTestId('provider-search-s1');

      fireEvent.change(input, { target: { value: 'Mar' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      fireEvent.change(input, { target: { value: 'Marta' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(mockListWorkers).toHaveBeenCalledTimes(2);

      // A consulta NOVA responde primeiro...
      await act(async () => { second.resolve({ data: [{ id: 'w-marta', name: 'Marta Nueva' }] }); });
      expect(screen.getByTestId('provider-hit-w-marta')).toBeTruthy();

      // ...e a VELHA chega depois. A tela lê "Marta"; a lista não pode virar a de "Mar".
      await act(async () => { first.resolve({ data: [{ id: 'w-mar', name: 'Mar Viejo' }] }); });
      expect(screen.queryByTestId('provider-hit-w-mar')).toBeNull();
      expect(screen.getByTestId('provider-hit-w-marta')).toBeTruthy();
    });

    it('busca que FALHA não deixa o resultado da consulta ANTERIOR na tela — e diz que falhou', async () => {
      mockListWorkers
        .mockResolvedValueOnce({ data: [{ id: 'w-ana', name: 'Ana Anterior' }] })
        .mockRejectedValueOnce(new Error('HTTP 500'));
      render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
      const input = screen.getByTestId('provider-search-s1');

      fireEvent.change(input, { target: { value: 'ana' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(screen.getByTestId('provider-hit-w-ana')).toBeTruthy();

      fireEvent.change(input, { target: { value: 'zzz' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      // A lista de "ana" NÃO pode continuar embaixo da consulta "zzz".
      expect(screen.queryByTestId('provider-hit-w-ana')).toBeNull();
      expect(screen.getByText(/No se pudo buscar/i)).toBeTruthy();
    });

    it('REJEIÇÃO obsoleta também é descartada: a busca velha falhar não pode apagar a lista da nova nem gritar erro', async () => {
      const first = deferred<{ data: unknown[] }>();
      const second = deferred<{ data: unknown[] }>();
      first.promise.catch(() => {}); // evita unhandledRejection no Node ao rejeitar mais tarde
      mockListWorkers.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
      const input = screen.getByTestId('provider-search-s1');

      fireEvent.change(input, { target: { value: 'Mar' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      fireEvent.change(input, { target: { value: 'Marta' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });

      await act(async () => { second.resolve({ data: [{ id: 'w-marta', name: 'Marta Nueva' }] }); });
      expect(screen.getByTestId('provider-hit-w-marta')).toBeTruthy();

      // A busca VELHA rejeita DEPOIS — obsoleta: não pode limpar a lista nova nem virar erro.
      await act(async () => { first.reject(new Error('rede caiu na busca velha')); });
      expect(screen.getByTestId('provider-hit-w-marta')).toBeTruthy();
      expect(screen.queryByText(/No se pudo buscar/i)).toBeNull();
    });

    it('debounce: digitar "Marta" letra a letra dispara UMA busca, não cinco', async () => {
      mockListWorkers.mockResolvedValue({ data: [] });
      render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
      const input = screen.getByTestId('provider-search-s1');
      for (const term of ['Ma', 'Mar', 'Mart', 'Marta']) {
        fireEvent.change(input, { target: { value: term } });
        await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      expect(mockListWorkers).toHaveBeenCalledTimes(1);
      expect(mockListWorkers).toHaveBeenCalledWith({ search: 'Marta', limit: '5' });
    });

    it('cair abaixo de 2 caracteres descarta a resposta em voo (não repovoa a lista depois de limpar)', async () => {
      const inflight = deferred<{ data: unknown[] }>();
      mockListWorkers.mockReturnValueOnce(inflight.promise);
      render(<ContractedServiceProvidersSection patientId="pat1" serviceId="s1" providers={[]} onChanged={vi.fn()} />);
      const input = screen.getByTestId('provider-search-s1');
      fireEvent.change(input, { target: { value: 'bru' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(400); });
      fireEvent.change(input, { target: { value: 'b' } });
      await act(async () => { inflight.resolve({ data: [{ id: 'w-bru', name: 'Bruno' }] }); });
      expect(screen.queryByTestId('provider-hit-w-bru')).toBeNull();
    });
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
