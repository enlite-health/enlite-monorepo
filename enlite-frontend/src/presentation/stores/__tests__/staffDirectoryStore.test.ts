/**
 * staffDirectoryStore — fonte injetada do popup de menção estilo ClickUp (spec 022, Rodada 2/
 * R2-F). `search(q)` alimenta o autocomplete a cada digitação; `loadAll()` alimenta o "Mostrar
 * todos" (limit=200, sem filtro — decisão do Gabriel 22/09). Os dois alimentam `staffNameCache`
 * (mesmo efeito colateral que `MessageComposer` fazia antes, agora centralizado aqui — fix-once).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminConversationApiService } from '@infrastructure/http/AdminConversationApiService';
import { useStaffNameCache } from '../staffNameCache';
import { useStaffDirectoryStore } from '../staffDirectoryStore';

vi.mock('@infrastructure/http/AdminConversationApiService', () => ({
  AdminConversationApiService: { searchStaffDirectory: vi.fn() },
}));

const ENTRIES = [
  { uid: 'u-1', displayName: 'QA Staff Um', isOnline: true },
  { uid: 'u-2', displayName: 'QA Staff Dois', isOnline: false },
];

describe('staffDirectoryStore (spec 022, Rodada 2/R2-F)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStaffDirectoryStore.setState({ entries: [], loading: false, error: false });
    useStaffNameCache.setState({ names: {} });
  });

  it('search(q): chama o client com q, devolve e guarda as entries, alimenta o staffNameCache', async () => {
    vi.mocked(AdminConversationApiService.searchStaffDirectory).mockResolvedValue(ENTRIES);

    const result = await useStaffDirectoryStore.getState().search('qa');

    expect(AdminConversationApiService.searchStaffDirectory).toHaveBeenCalledWith('qa');
    expect(result).toEqual(ENTRIES);
    expect(useStaffDirectoryStore.getState().entries).toEqual(ENTRIES);
    expect(useStaffDirectoryStore.getState().error).toBe(false);
    expect(useStaffNameCache.getState().names).toEqual({ 'u-1': 'QA Staff Um', 'u-2': 'QA Staff Dois' });
  });

  it('search(q) falha (rede/403/500): error=true no estado, mas REJEITA (quem injeta — createMentionSuggestion — decide a semântica visível)', async () => {
    vi.mocked(AdminConversationApiService.searchStaffDirectory).mockRejectedValue(new Error('network'));

    await expect(useStaffDirectoryStore.getState().search('qa')).rejects.toThrow('network');

    expect(useStaffDirectoryStore.getState().entries).toEqual([]);
    expect(useStaffDirectoryStore.getState().error).toBe(true);
    expect(useStaffDirectoryStore.getState().loading).toBe(false);
  });

  it('loadAll(): chama o client SEM filtro e com limit=200 ("Mostrar todos" — decisão do Gabriel)', async () => {
    vi.mocked(AdminConversationApiService.searchStaffDirectory).mockResolvedValue(ENTRIES);

    const result = await useStaffDirectoryStore.getState().loadAll();

    expect(AdminConversationApiService.searchStaffDirectory).toHaveBeenCalledWith('', 200);
    expect(result).toEqual(ENTRIES);
    expect(useStaffDirectoryStore.getState().entries).toEqual(ENTRIES);
  });

  it('loadAll() falha: error=true no estado, mas REJEITA', async () => {
    vi.mocked(AdminConversationApiService.searchStaffDirectory).mockRejectedValue(new Error('network'));

    await expect(useStaffDirectoryStore.getState().loadAll()).rejects.toThrow('network');

    expect(useStaffDirectoryStore.getState().error).toBe(true);
  });

  it('search(q, patientId): repassa patientId ao client (contrato novo R3-1)', async () => {
    vi.mocked(AdminConversationApiService.searchStaffDirectory).mockResolvedValue(ENTRIES);

    await useStaffDirectoryStore.getState().search('qa', 'patient-1');

    expect(AdminConversationApiService.searchStaffDirectory).toHaveBeenCalledWith('qa', undefined, 'patient-1');
  });

  it('search(q) SEM patientId: chama o client só com q — nenhum ripple no caller que não tem paciente', async () => {
    vi.mocked(AdminConversationApiService.searchStaffDirectory).mockResolvedValue(ENTRIES);

    await useStaffDirectoryStore.getState().search('qa');

    expect(AdminConversationApiService.searchStaffDirectory).toHaveBeenCalledWith('qa');
  });

  it('loadAll(patientId): repassa patientId ao client junto do limit=200 (contrato novo R3-1)', async () => {
    vi.mocked(AdminConversationApiService.searchStaffDirectory).mockResolvedValue(ENTRIES);

    await useStaffDirectoryStore.getState().loadAll('patient-1');

    expect(AdminConversationApiService.searchStaffDirectory).toHaveBeenCalledWith('', 200, 'patient-1');
  });

  it('loadAll() SEM patientId: comportamento de antes, sem o 3º argumento', async () => {
    vi.mocked(AdminConversationApiService.searchStaffDirectory).mockResolvedValue(ENTRIES);

    await useStaffDirectoryStore.getState().loadAll();

    expect(AdminConversationApiService.searchStaffDirectory).toHaveBeenCalledWith('', 200);
  });

  it('loading fica true DURANTE a chamada e volta a false ao terminar', async () => {
    let resolveFn: (v: typeof ENTRIES) => void;
    vi.mocked(AdminConversationApiService.searchStaffDirectory).mockReturnValue(
      new Promise((resolve) => { resolveFn = resolve; }),
    );

    const promise = useStaffDirectoryStore.getState().search('qa');
    expect(useStaffDirectoryStore.getState().loading).toBe(true);
    resolveFn!(ENTRIES);
    await promise;
    expect(useStaffDirectoryStore.getState().loading).toBe(false);
  });
});
