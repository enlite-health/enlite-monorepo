import { create } from 'zustand';
import { useAdminAuthStore } from './adminAuthStore';

interface StaffNameCacheState {
  /** uid → displayName, só do que já foi VISTO nesta sessão (nunca persistido). */
  names: Record<string, string>;
  /** Registra entradas novas (ignora `displayName` vazio) — idempotente. */
  remember: (entries: ReadonlyArray<{ uid: string; displayName: string | null | undefined }>) => void;
}

/**
 * Cache de sessão (nunca persistido, nunca em disco) `uid → displayName` para o chat interno
 * (spec 022, achado baixo do gate do B2 — `ThreadView.tsx` mostrava uid cru).
 *
 * 🔒 POR QUE NÃO É UMA RESOLUÇÃO COMPLETA: `GET .../conversation` (contrato,
 * `contracts/openapi-conversation.md`) só devolve `authorUid`, nunca um nome — e
 * `GET /api/admin/staff-directory` (`contracts/openapi-staff-directory.md`) só busca por TEXTO
 * (`q`, min 2 chars, ILIKE em `display_name`/`email`), não existe "resolver uid → nome" no
 * contrato hoje. Sem tocar no backend (fora do escopo deste conserto), a única fonte real de
 * nome é quem o ATOR já viu: os resultados do autocomplete de menção (`MessageComposer`) alimentam
 * este cache; quem nunca foi buscado segue mostrando o uid — fallback, nunca nome inventado.
 */
export const useStaffNameCache = create<StaffNameCacheState>((set) => ({
  names: {},
  remember: (entries) => set((state) => {
    let changed = false;
    const names = { ...state.names };
    for (const entry of entries) {
      if (entry.displayName && names[entry.uid] !== entry.displayName) {
        names[entry.uid] = entry.displayName;
        changed = true;
      }
    }
    return changed ? { names } : state;
  }),
}));

/**
 * Nome de exibição de `uid` — com fallback para o PRÓPRIO uid quando não é resolvível (nunca
 * quebra, nunca inventa nome). Resolve em duas fontes, nesta ordem:
 *  1. é o próprio ator logado (`adminProfile` da mesma sessão) → nome de verdade, sempre;
 *  2. já apareceu numa busca do diretório de staff nesta sessão (`useStaffNameCache`) → nome
 *     de verdade;
 *  3. nenhuma das duas → o uid cru (fallback, nunca vazio).
 */
export function useStaffDisplayName(uid: string): string {
  const myUid = useAdminAuthStore((s) => s.authz?.uid);
  const myDisplayName = useAdminAuthStore((s) => s.adminProfile?.displayName);
  const cachedName = useStaffNameCache((s) => s.names[uid]);
  if (uid === myUid && myDisplayName) return myDisplayName;
  return cachedName ?? uid;
}
