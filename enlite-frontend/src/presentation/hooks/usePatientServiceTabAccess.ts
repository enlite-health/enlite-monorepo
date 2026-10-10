import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { screenById } from '@presentation/config/screenRegistry';
import { useActionGate, tabsVisibleFor } from '@presentation/hooks/useCellAccess';

/**
 * O operador consegue ABRIR a aba "Servicio Contratado" da ficha do paciente?
 *
 * Duas condições, as MESMAS que a própria ficha aplica (nenhuma regra nova):
 *  - `patient:read` — `GET /patients/:id` é `perm.require('patient', 'read')`; sem a célula a ficha é 403.
 *  - a aba existe para o ator (D286: `tabsVisibleFor`, qualquer célula de qualquer container da aba — coverage,
 *    address, services, contract value ou `vacancy`).
 * Com o engine de enforcement desligado, ambas liberam (mesmo freio de `useActionGate`/`tabsVisibleFor`).
 *
 * Quem NÃO passa vê texto sem link: levar a pessoa a um 403 não ajuda ninguém.
 */
export function usePatientServiceTabAccess(): boolean {
  const permissions = useAdminAuthStore((s) => s.authz?.permissions);
  const enforcement = useAdminAuthStore((s) => s.authz?.enforcement);
  const { allowed: canReadPatient } = useActionGate('patient', 'read');
  const tabVisible =
    tabsVisibleFor(screenById('patients.detail'), ['contractedService'], permissions, enforcement).length > 0;
  return canReadPatient && tabVisible;
}
