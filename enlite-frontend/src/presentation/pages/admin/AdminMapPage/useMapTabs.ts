import { useState } from 'react';
import { tabsVisibleFor } from '@presentation/hooks/useCellAccess';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { screenById } from '@presentation/config/screenRegistry';

export type MapKind = 'workers' | 'patients';
export const MAP_TABS: readonly MapKind[] = ['workers', 'patients'];

/**
 * D286 fase 2 — cada aba do mapa é um container com célula própria: Prestadores = `worker_address`
 * (a mesma do card de endereço da ficha), Pacientes = `patient_address` (a mesma da ficha do
 * paciente). A aba some sem a célula; a ativa cai na primeira visível. Sem nenhuma visível (ator sem
 * as duas células de endereço), `kind` fica no pedido — as abas não desenham e nenhuma busca sai,
 * porque o hook de pontos só dispara com âncora escolhida.
 */
export function useMapTabs(): { visibleTabs: MapKind[]; kind: MapKind; setKind: (k: MapKind) => void } {
  const permissions = useAdminAuthStore((s) => s.authz?.permissions);
  const enforcement = useAdminAuthStore((s) => s.authz?.enforcement);
  const visibleTabs = tabsVisibleFor(screenById('map'), MAP_TABS, permissions, enforcement);
  const [kindState, setKind] = useState<MapKind>('workers');
  const kind: MapKind = visibleTabs.includes(kindState) ? kindState : (visibleTabs[0] ?? kindState);
  return { visibleTabs, kind, setKind };
}
