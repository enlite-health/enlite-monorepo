import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminPermissionsApiService, type PermissionAuditRow } from '@infrastructure/http/AdminPermissionsApiService';
import { Heading, Text, Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Input, Label } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { AccessGate } from './AccessGate';

/**
 * `/admin/access/audit` — a trilha de decisões. Só leitura por natureza: não há
 * ação de conclusão aqui, então `read` e `write` renderizam o mesmo. O que a
 * trilha mostra é identificador e metadado — nunca conteúdo (spec da vista de
 * auditoria); `resourceId` chega `<oculto>` fora do país do auditor (mig 283).
 */
export function AuditPage(): JSX.Element {
  return (
    <AccessGate>
      <AuditTrail />
    </AccessGate>
  );
}

function AuditTrail(): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<PermissionAuditRow[]>([]);
  const [filters, setFilters] = useState({ userId: '', resource: '', limit: '100' });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Recebe os filtros por parâmetro: um `useCallback` fechado sobre o estado
  // buscaria sempre com os filtros INICIAIS — o botão "Buscar" mentiria.
  const load = useCallback(async (f: typeof filters) => {
    setIsLoading(true);
    setError(null);
    try {
      setRows(await AdminPermissionsApiService.queryAudit({
        userId: f.userId || undefined,
        resource: f.resource || undefined,
        limit: Number(f.limit) || undefined,
      }));
    } catch {
      setError('admin.access.audit.loadError');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Carrega uma vez; depois só pelo botão — a trilha não é reativa por tecla.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(filters); }, [load]);

  return (
    <div className="space-y-4">
      <Heading level={2} weight="semibold" color="primary">{t('admin.access.audit.title')}</Heading>
      <Text size="xs" color="secondary">{t('admin.access.audit.note')}</Text>
      <form
        className="flex gap-3 items-end flex-wrap"
        onSubmit={(e) => { e.preventDefault(); void load(filters); }}
      >
        <div>
          <Label htmlFor="au-user">{t('admin.access.audit.userId')}</Label>
          <Input id="au-user" value={filters.userId} onChange={(e) => setFilters((f) => ({ ...f, userId: e.target.value }))} />
        </div>
        <div>
          <Label htmlFor="au-res">{t('admin.access.audit.resource')}</Label>
          <Input id="au-res" value={filters.resource} onChange={(e) => setFilters((f) => ({ ...f, resource: e.target.value }))} />
        </div>
        <div className="w-28">
          <Label htmlFor="au-limit">{t('admin.access.audit.limit')}</Label>
          <Input id="au-limit" type="number" min={1} max={500} value={filters.limit} onChange={(e) => setFilters((f) => ({ ...f, limit: e.target.value }))} />
        </div>
        <Button type="submit" variant="outline" size="sm">{t('admin.access.audit.search')}</Button>
      </form>
      {error && (
        <div className="bg-red-50 border border-red-200 px-4 py-3 rounded-lg" role="alert">
          <Text size="sm" color="primary">{t(error)}</Text>
        </div>
      )}
      {isLoading ? (
        <TableSkeleton />
      ) : (
        <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-400">
          {/* lex C1: uid de staff, id de recurso e decisão não podem ir à gravação de sessão do Clarity. */}
          <Table data-clarity-mask="True">
            <TableHeader>
              <TableHead>{t('admin.access.audit.when')}</TableHead>
              <TableHead>{t('admin.access.audit.userId')}</TableHead>
              <TableHead>{t('admin.access.audit.resource')}</TableHead>
              <TableHead>{t('admin.access.audit.action')}</TableHead>
              <TableHead>{t('admin.access.audit.decision')}</TableHead>
              <TableHead>{t('admin.access.audit.resourceId')}</TableHead>
              <TableHead>{t('admin.access.audit.country')}</TableHead>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{new Date(r.createdAt).toLocaleString('es-AR')}</TableCell>
                  <TableCell><span className="font-mono text-xs">{r.userId}</span></TableCell>
                  <TableCell>{r.resource}</TableCell>
                  <TableCell>{r.action}</TableCell>
                  <TableCell weight="medium">{r.decision}</TableCell>
                  <TableCell><span className="font-mono text-xs">{r.resourceId ?? '—'}</span></TableCell>
                  <TableCell>{r.country ?? '—'}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell unwrapped colSpan={7} className="px-6 py-8 text-center">
                    <Text as="span" size="sm" color="secondary">{t('admin.access.audit.empty')}</Text>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
