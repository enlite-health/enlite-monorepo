import { Navigate, useLocation } from 'react-router-dom';

/**
 * Redirect que carrega a query junto. Usado pela rota antiga `/admin/mi-cuenta/tactiq`: o aviso no sino e a volta do OAuth
 * do Tactiq (`TACTIQ_LINK_RETURN_URL`) ainda apontam para ela, e `?tactiq=linked|error` tem de sobreviver para o banner do
 * retorno aparecer na página Perfil.
 */
export function RedirectKeepingSearch({ to }: { to: string }): JSX.Element {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}
