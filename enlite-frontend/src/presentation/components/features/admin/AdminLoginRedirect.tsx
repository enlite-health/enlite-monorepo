import { Navigate, useSearchParams } from 'react-router-dom';
import { adminLoginPath, safeAdminNext } from '@presentation/config/adminLoginPath';

/**
 * Rota legada `/admin/login`: o login é único (`/login`). Preserva o `next` de origem
 * quando houver (`/admin/login?next=/admin/x` → `/login?next=%2Fadmin%2Fx`).
 */
export function AdminLoginRedirect(): JSX.Element {
  const [params] = useSearchParams();
  return <Navigate to={adminLoginPath(safeAdminNext(params.get('next')))} replace />;
}
