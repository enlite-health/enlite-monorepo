/**
 * CustosPage — `/admin/custos` (spec 082): faturamento do GCP por mês, serviço, recurso, setor e chamador de IA.
 * Abre com a célula `platform_costs:read` (só Master). SEM item no menu e SEM link em lugar nenhum (DF-2): acesso só pela URL;
 * quem barra é a célula (e a API, com 403) — URL escondida sozinha não protege nada.
 * Ao abrir NÃO consulta (RF-2): cada clique em "Sincronizar" é UMA chamada; o resultado vive só no estado deste componente
 * (nada em localStorage). Estados: sem dados / sincronizando / erro (texto próprio p/ bytes_limit e 429) / sem permissão.
 */
import { useCallback, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { useCellAccess, useContainerAccess } from '@presentation/hooks/useCellAccess';
import { AdminCostsApiService, type CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { CustosCards, CustosMeses } from './CustosCards';
import { CustosAnomalias, CustosTables } from './CustosTables';
import { custosErrorKey, type CustosErro } from './custosErrors';
import { formatDateTime, isExportStale } from './custosFormat';

type Estado = 'idle' | 'syncing' | 'ready' | 'error';

export function CustosPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const access = useCellAccess('platform_costs');
  const { visible } = useContainerAccess('platform_costs');
  const [estado, setEstado] = useState<Estado>('idle');
  const [dados, setDados] = useState<CostOverview | null>(null);
  const [erro, setErro] = useState<CustosErro | null>(null);
  const voando = useRef(false);

  const sincronizar = useCallback(async () => {
    if (voando.current) return;
    voando.current = true;
    setEstado('syncing');
    setErro(null);
    try {
      setDados(await AdminCostsApiService.getOverview());
      setEstado('ready');
    } catch (e) {
      setErro(custosErrorKey(e));
      setEstado('error');
    } finally {
      voando.current = false;
    }
  }, []);

  if (access.status === 'idle' || access.status === 'loading') {
    return <p className="text-sm text-[#404040]">{t('admin.custos.authzLoading')}</p>;
  }
  if (access.status === 'error') {
    return <div role="alert" className="text-sm font-medium text-[#7A0C0C]">{t('admin.custos.authzError')}</div>;
  }
  if (!visible) return <Navigate to="/admin" replace />;

  const sincronizando = estado === 'syncing';
  const vazio = dados !== null && dados.dataUntil === null;
  const atrasado = dados !== null && isExportStale(dados.dataUntil);
  const forbidden = erro?.key === 'admin.custos.errors.forbidden';

  return (
    <div data-testid="custos-page" className="mx-auto w-full max-w-4xl space-y-4 overflow-x-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[#1A1A1A]">{t('admin.custos.title')}</h1>
          <p className="text-sm text-[#404040]">{t('admin.custos.subtitle')}</p>
        </div>
        {!forbidden && (
          <button
            type="button"
            data-testid="custos-sincronizar"
            disabled={sincronizando}
            onClick={() => void sincronizar()}
            className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg bg-[#0B2E6B] px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            {sincronizando
              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            {sincronizando ? t('admin.custos.syncing') : estado === 'error' ? t('admin.custos.retry') : t('admin.custos.sync')}
          </button>
        )}
      </div>

      {sincronizando && <p role="status" data-testid="custos-sincronizando" className="text-sm text-[#404040]">{t('admin.custos.syncing')}</p>}

      {erro && (
        <div role="alert" data-testid="custos-erro" data-code={erro.key} className="text-sm font-medium text-[#7A0C0C]">
          {t(erro.key, { seconds: erro.seconds ?? 0 })}
        </div>
      )}

      {dados === null && estado === 'idle' && <p data-testid="custos-idle" className="text-sm text-[#404040]">{t('admin.custos.idle')}</p>}

      {dados !== null && dados.dataUntil && (
        <div className="space-y-2">
          <p data-testid="custos-dados-ate" className="text-sm font-medium text-[#262626]">
            {t('admin.custos.dataUntil', { date: formatDateTime(dados.dataUntil, i18n?.language) })}
          </p>
          {atrasado && (
            <div role="alert" data-testid="custos-atrasado" className="rounded-lg border border-[#8A6100] bg-[#FFF4D6] px-4 py-2 text-xs text-[#4A3300]">
              {t('admin.custos.stale')}
            </div>
          )}
        </div>
      )}

      {vazio && <p data-testid="custos-vazio" className="text-sm text-[#404040]">{t('admin.custos.emptyMonth')}</p>}

      {dados !== null && !vazio && (
        <div className="space-y-4" data-testid="custos-resultado">
          <CustosCards ov={dados} />
          <CustosMeses ov={dados} />
          <CustosTables ov={dados} />
          <CustosAnomalias ov={dados} />
        </div>
      )}
    </div>
  );
}
