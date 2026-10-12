import { Navigate } from 'react-router-dom';
import { useFeature } from '@presentation/hooks/useFeature';
import { ADMIN_HOME_PATH, ADMIN_USERS_PATH } from '@presentation/config/adminHome';

/**
 * Índice de `/admin`: não é tela, só decide o destino.
 *
 * `/admin/dashboard` está atrás de `FeatureRouteGate`, que devolve a `/admin` quando
 * `screen:management-dashboard` está desligada no país — sem o ramo para Usuários isso
 * seria loop infinito. As duas pontas leem a MESMA `useFeature` sobre o mesmo store, então
 * decidem igual em qualquer estado (fail-open enquanto o authz não chegou/erro: os dois
 * dizem "ligada" e o dashboard renderiza).
 */
export function AdminHomeRedirect(): JSX.Element {
  const dashboardOn = useFeature('screen:management-dashboard');
  return <Navigate to={dashboardOn ? ADMIN_HOME_PATH : ADMIN_USERS_PATH} replace />;
}
