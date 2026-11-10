import { AccessGate } from './AccessGate';
import { AreaMembershipsTab } from './AreaMembershipsTab';

/**
 * `/admin/access/area-memberships` — a aba "Vínculos de área". Guarda: `area_membership:read` (quem só
 * tem essa célula entra no painel só por aqui). Conceder/revogar exigem `area_membership:write`.
 */
export function AreaMembershipsPage(): JSX.Element {
  return (
    <AccessGate tab="areaMemberships">
      <AreaMembershipsTab />
    </AccessGate>
  );
}
