/**
 * staffDirectoryStore — fonte injetada do popup de menção estilo ClickUp (spec 022, Rodada 2/
 * R2-F, `docs/.../tasks.md` "Rodada 2"). `search(q)` alimenta o autocomplete a cada digitação
 * (via `configureMentionSuggestion({ fetchCandidates: ... })`); `loadAll()` alimenta o "Mostrar
 * todos" (`limit=200`, sem filtro — decisão do Gabriel 22/09: "carrega a lista inteira ... com
 * scroll").
 *
 * 🔒 `staffNameCache.remember` MOVE PARA CÁ (fix-once): antes vivia dentro do `MessageComposer`
 * (`onResults` do `configureMentionSuggestion`) — único caller até esta Rodada. Com o popup
 * também alimentado por `loadAll()` (fora do fluxo `items()` do TipTap), duplicar o `remember` em
 * dois lugares seria a MESMA classe de bug que a extração dos módulos evita. Este store é agora o
 * ÚNICO ponto que alimenta o cache a partir do diretório de staff.
 */
import { create } from 'zustand';
import { AdminConversationApiService, type StaffDirectoryEntry } from '@infrastructure/http/AdminConversationApiService';
import { useStaffNameCache } from './staffNameCache';

/** Teto do backend (`MAX_STAFF_DIRECTORY_LIMIT`, `staffDirectorySchema.ts`) — "Mostrar todos" pede
 * o máximo permitido, nunca paginação própria (V1, decisão registrada no backend R2-B). */
const SHOW_ALL_LIMIT = 200;

interface StaffDirectoryState {
  entries: StaffDirectoryEntry[];
  loading: boolean;
  /** `true` só quando a ÚLTIMA chamada falhou (rede/403/500) — distinto de "0 resultados de
   * verdade" (mesma régua de F5, item 1). */
  error: boolean;
  /** Devolve as entries (além de atualizar o estado) — é a forma que o popup de menção consome
   * como `fetchCandidates` injetado em `configureMentionSuggestion`. */
  search: (q: string) => Promise<StaffDirectoryEntry[]>;
  loadAll: () => Promise<StaffDirectoryEntry[]>;
}

/**
 * 🔒 REJEITA, não engole (achado desta rodada, ao ligar o popup de menção): `fetchCandidates`/
 * `loadAll` injetados em `configureMentionSuggestion` já têm o PRÓPRIO try/catch — é ele quem
 * decide a semântica visível pro autocomplete ("falha vira `[]` + flag de erro DISTINTA de 0
 * resultados", F5/item 1). Se este store engolisse o erro aqui, `items()` do TipTap NUNCA veria a
 * rejeição, o popup mostraria "0 resultados" onde deveria mostrar "falhou" — a mesma mentira que a
 * F5 foi escrita para evitar. `loading`/`error` no estado do store são para outro tipo de
 * consumidor (um painel que observa reativamente, sem try/catch); a rejeição sempre propaga.
 */
async function fetchAndRemember(
  set: (partial: Partial<StaffDirectoryState>) => void,
  request: () => Promise<StaffDirectoryEntry[]>,
): Promise<StaffDirectoryEntry[]> {
  set({ loading: true, error: false });
  try {
    const results = await request();
    useStaffNameCache.getState().remember(results);
    set({ entries: results, loading: false, error: false });
    return results;
  } catch (err) {
    set({ loading: false, error: true });
    throw err;
  }
}

export const useStaffDirectoryStore = create<StaffDirectoryState>((set) => ({
  entries: [],
  loading: false,
  error: false,
  search: (q) => fetchAndRemember(set, () => AdminConversationApiService.searchStaffDirectory(q)),
  loadAll: () => fetchAndRemember(set, () => AdminConversationApiService.searchStaffDirectory('', SHOW_ALL_LIMIT)),
}));
