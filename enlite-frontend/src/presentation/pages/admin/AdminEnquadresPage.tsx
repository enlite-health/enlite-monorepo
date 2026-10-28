/**
 * AdminEnquadresPage — `/admin/enquadres` (spec 076): a lista GLOBAL dos eventos de enquadre, entre vagas. Abre só com as DUAS
 * células (`enquadre_event:read` + `vacancy:read`, `openWith: 'all'`) — a MESMA decisão do menu (`screenVisibleFor`). O estado
 * (período, status, entrevistador, país, busca, página) mora na URL. Os totais vêm do servidor e valem para o conjunto filtrado
 * INTEIRO: a tela nunca soma a página. Esqueleto só na 1ª carga; depois `aria-busy`. Sem dado de paciente/convocado na tela.
 */
import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { TablePagination } from '@presentation/components/molecules/TablePagination';
import { screenById } from '@presentation/config/screenRegistry';
import { screenVisibleFor } from '@presentation/hooks/useCellAccess';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useEnquadresList } from '@hooks/admin/useEnquadresList';
import { EnquadresFilters } from '@presentation/components/features/admin/EnquadresList/EnquadresFilters';
import { EnquadresTable } from '@presentation/components/features/admin/EnquadresList/EnquadresTable';
import { formatDdMmYyyy } from '@presentation/components/features/admin/PatientDetail/ddMmDate';
import { parse, serialize, type EnquadresListFilters } from '@presentation/components/features/admin/EnquadresList/enquadresListParams';

export default function AdminEnquadresPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const permissions = useAdminAuthStore((s) => s.authz?.permissions);
  const enforcement = useAdminAuthStore((s) => s.authz?.enforcement);

  // Trava de rota: a mesma função do menu (as duas células). Sem acesso, nada é carregado.
  const screen = screenById('enquadres');
  const allowed = screen !== undefined && screenVisibleFor(screen, permissions, enforcement);
  useEffect(() => {
    if (!allowed) navigate('/admin', { replace: true });
  }, [allowed, navigate]);

  const filters = useMemo(() => parse(searchParams), [searchParams]);
  const update = useCallback(
    (next: Partial<EnquadresListFilters>) => setSearchParams(serialize({ ...filters, ...next })),
    [filters, setSearchParams],
  );

  const { status, data, errorCode, reload } = useEnquadresList({
    from: filters.from || undefined,
    to: filters.to || undefined,
    status: filters.status,
    host: filters.host || undefined,
    country: filters.country || undefined,
    q: filters.q || undefined,
    limit: filters.pageSize,
    offset: (filters.page - 1) * filters.pageSize,
  }, allowed);

  if (!allowed) return null;

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const startIndex = (filters.page - 1) * filters.pageSize;
  const busy = status === 'loading';

  return (
    <PageContainer>
      <div data-testid="enquadres-page">
        {/* Cartão único (mesmas classes de Pacientes/Prestadores: fundo branco, borda #D9D9D9, raio 20px, px-7); título e ajuda juntos */}
        <div className="bg-white rounded-[20px] border-2 border-[#D9D9D9] px-7 py-5 mb-6">
          <Heading level={1} className="text-[#737373] font-poppins text-2xl mb-1" data-testid="enquadres-title">{t('admin.enquadres.title')}</Heading>
          <Text size="sm" color="muted" className="mb-4" data-testid="enquadres-help">{t('admin.enquadres.helpNotIndicator21')}</Text>
          <EnquadresFilters
            filters={filters}
            shownRange={data ? { from: data.range.from, to: data.range.to } : null}
            hosts={data?.hosts ?? []}
            countries={data?.scope.countries ?? []}
            onChange={update}
          />
        </div>

        {status === 'error' ? (
          <div className="py-12 text-center flex flex-col items-center gap-3" data-testid="enquadres-error">
            <Text color="inherit" className="text-red-600">
              {errorCode ? t(`admin.enquadres.errors.${errorCode}`, { defaultValue: t('admin.enquadres.errors.generic') }) : t('admin.enquadres.loadError')}
            </Text>
            <Button variant="outline" size="sm" onClick={reload} data-testid="enquadres-retry">{t('admin.enquadres.retry')}</Button>
          </div>
        ) : data === null ? (
          <TableSkeleton />
        ) : (
          <div className={`transition-opacity ${busy ? 'opacity-60' : ''}`} aria-busy={busy} data-testid="enquadres-region">
            <Text size="sm" weight="medium" className="mb-3" data-testid="enquadres-totals" aria-live="polite">
              {`${t('admin.enquadres.totals.enquadres', { count: data.total })} · ${t('admin.enquadres.totals.convoked', { count: data.convokedTotal })}`}
            </Text>
            {data.items.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
                <Text size="sm" color="muted" data-testid="enquadres-empty">
                  {t('admin.enquadres.empty', { from: formatDdMmYyyy(data.range.from), to: formatDdMmYyyy(data.range.to) })}
                </Text>
              </div>
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 overflow-visible">
                <EnquadresTable items={data.items} />
              </div>
            )}
            <div className="mt-6">
              <TablePagination
                currentPage={filters.page}
                totalPages={totalPages}
                totalItems={total}
                itemsPerPage={filters.pageSize}
                startIndex={total === 0 ? -1 : startIndex}
                endIndex={Math.min(filters.page * filters.pageSize, total)}
                onPrevPage={() => update({ page: Math.max(1, filters.page - 1) })}
                onNextPage={() => update({ page: Math.min(totalPages, filters.page + 1) })}
                onItemsPerPageChange={(n) => update({ pageSize: n, page: 1 })}
              />
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
