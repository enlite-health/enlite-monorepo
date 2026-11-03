/**
 * CustosPage — `/admin/custos` (spec 082, direção A "Sinal primeiro"): veredito → 3 números do mês → "Quem gasta" → 6 meses.
 * Abre com a célula `platform_costs:read` (só Master). SEM item no menu e SEM link em lugar nenhum (DF-2): acesso só pela URL;
 * quem barra é a célula (e a API, com 403) — URL escondida sozinha não protege nada.
 * Ao abrir NÃO consulta (RF-2): cada "Sincronizar" (e cada troca de mês, DF-20) é UMA chamada; o resultado vive só no estado deste
 * componente (nada em localStorage). "Ver detalhe" (A2, DF-18) troca um estado local: ZERO chamadas.
 * Estados: antes de sincronizar / sincronizando / mês sem dados (com atalho) / erro (texto próprio p/ bytes_limit e 429) / sem permissão.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { useCellAccess, useContainerAccess } from '@presentation/hooks/useCellAccess';
import { Button } from '@presentation/components/atoms/Button';
import { Combobox } from '@presentation/components/atoms/Combobox';
import { Heading } from '@presentation/components/atoms/Heading';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Text } from '@presentation/components/atoms/Text';
import { AdminCostsApiService, type CostAnomalyItem, type CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { CustosDetalhe } from './CustosDetalhe';
import { CustosKpis } from './CustosKpis';
import { CustosMeses } from './CustosMeses';
import { CustosQuemGasta } from './CustosQuemGasta';
import { CustosVeredito } from './CustosVeredito';
import { custosErrorKey, type CustosErro } from './custosErrors';
import { capitalize, currentMonthKey, formatDateTime, isExportStale, monthLabel } from './custosFormat';
import { CARD, Linha } from './custosUi';

type Estado = 'idle' | 'syncing' | 'ready' | 'error';
interface Detalhe { kind: CostAnomalyItem['kind']; name: string }

export function CustosPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const lang = i18n?.language;
  const access = useCellAccess('platform_costs');
  const { visible } = useContainerAccess('platform_costs');
  const [estado, setEstado] = useState<Estado>('idle');
  const [dados, setDados] = useState<CostOverview | null>(null);
  const [erro, setErro] = useState<CustosErro | null>(null);
  /** Mês escolhido no seletor; `null` = o corrente (o backend assume o mês corrente sem `month`). */
  const [mes, setMes] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const voando = useRef(false);
  const voltarPara = useRef<string | null>(null);

  /** Devolve `true` se a leitura entrou; falha MANTÉM `dados` (o que está na tela continua valendo) e só mostra o erro (D3). */
  const sincronizar = useCallback(async (month?: string): Promise<boolean> => {
    if (voando.current) return false;
    voando.current = true;
    setEstado('syncing');
    setErro(null);
    try {
      setDados(await AdminCostsApiService.getOverview(month));
      setEstado('ready');
      return true;
    } catch (e) {
      setErro(custosErrorKey(e));
      setEstado('error');
      return false;
    } finally {
      voando.current = false;
    }
  }, []);

  // Volta ao A1 devolvendo o foco ao "Ver detalhe" de origem (RF-A13).
  useEffect(() => {
    if (detalhe !== null || voltarPara.current === null) return;
    const nome = voltarPara.current;
    voltarPara.current = null;
    Array.from(document.querySelectorAll<HTMLElement>('[data-ver-detalhe]')).find((el) => el.dataset.verDetalhe === nome)?.focus();
  }, [detalhe]);

  const corrente = currentMonthKey();
  const escolhido = mes ?? corrente;
  const opcoes = useMemo(() => {
    const meses = new Set<string>([corrente, escolhido, ...(dados?.availableMonths ?? [])]);
    return Array.from(meses).sort().reverse().map((m) => ({ value: m, label: monthLabel(m, lang) }));
  }, [corrente, escolhido, dados, lang]);

  if (access.status === 'idle' || access.status === 'loading') {
    return <PageContainer><Text color="primary" size="sm">{t('admin.custos.authzLoading')}</Text></PageContainer>;
  }
  if (access.status === 'error') {
    return <PageContainer><div role="alert"><Text color="primary" size="sm" weight="medium">{t('admin.custos.authzError')}</Text></div></PageContainer>;
  }
  if (!visible) return <Navigate to="/admin" replace />;

  const sincronizando = estado === 'syncing';
  const vazio = dados !== null && dados.dataUntil === null;
  // DF-22: o aviso de export atrasado só vale no mês corrente (num mês fechado `dataUntil` é o último dado da tabela, não do mês).
  const atrasado = dados !== null && dados.anomalies.status !== 'not_applicable' && isExportStale(dados.dataUntil);
  const forbidden = erro?.key === 'admin.custos.errors.forbidden';
  const item = dados && detalhe ? dados.anomalies.items.find((i) => i.kind === detalhe.kind && i.name === detalhe.name && i.detail) ?? null : null;
  const ultimoComDados = dados?.availableMonths.find((m) => m !== dados.month) ?? null;
  // Troca de mês: o seletor mostra o novo já; se a leitura falhar (429/502) ele volta ao mês que estava e os dados anteriores seguem na tela.
  const escolher = (m: string) => {
    const anterior = mes;
    setMes(m);
    void sincronizar(m).then((ok) => { if (ok) setDetalhe(null); else setMes(anterior); });
  };

  return (
    <PageContainer>
      <div data-testid="custos-page" className="flex min-w-0 flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <Heading level={1} weight="semibold" className="whitespace-nowrap">{t('admin.custos.title')}</Heading>
          {!forbidden && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              {dados?.dataUntil && (
                <Linha tipo="data" data-testid="custos-dados-ate" color="tertiary">{t('admin.custos.dataUntil', { date: formatDateTime(dados.dataUntil, lang) })}</Linha>
              )}
              <div className="w-[210px]" data-testid="custos-mes-select">
                <Combobox
                  inputSize="compact"
                  options={opcoes}
                  value={escolhido}
                  onChange={(m) => { if (m && m !== escolhido) escolher(m); }}
                  disabled={sincronizando}
                  aria-label={t('admin.custos.monthSelector')}
                  valueClassName="text-primary"
                />
              </div>
              <Button
                variant="primary"
                size="lg"
                data-testid="custos-sincronizar"
                disabled={sincronizando}
                aria-busy={sincronizando}
                onClick={() => void sincronizar(mes ?? undefined)}
              >
                {sincronizando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                <span className="whitespace-nowrap" data-single-line="selo">
                  {sincronizando ? t('admin.custos.syncing') : estado === 'error' ? t('admin.custos.retry') : t('admin.custos.sync')}
                </span>
              </Button>
            </div>
          )}
        </header>

        {erro && (
          <div role="alert" data-testid="custos-erro" data-code={erro.key} className="rounded-xl border border-red-900 bg-red-50 p-4">
            <Text color="inherit" size="sm" weight="medium" className="text-red-950">{t(erro.key, { seconds: erro.seconds ?? 0 })}</Text>
          </div>
        )}

        {sincronizando && (
          <section role="status" aria-live="polite" data-testid="custos-sincronizando" className={`${CARD} flex min-h-[320px] flex-col items-center justify-center gap-2 text-center`}>
            <Heading level={2} weight="semibold">{t('admin.custos.loading.title')}</Heading>
            <Text color="tertiary" size="sm">{t('admin.custos.loading.text')}</Text>
          </section>
        )}

        {!sincronizando && dados === null && estado === 'idle' && (
          <section role="status" aria-live="polite" data-testid="custos-idle" className={`${CARD} flex min-h-[320px] flex-col items-center justify-center gap-2 text-center`}>
            <Heading level={2} weight="semibold">{t('admin.custos.idle.title')}</Heading>
            <Text color="tertiary" size="sm">{t('admin.custos.idle.text')}</Text>
          </section>
        )}

        {!sincronizando && atrasado && dados && (
          <div role="alert" data-testid="custos-atrasado" className="flex min-w-0 items-start gap-3 rounded-xl border border-amber-800 bg-amber-50 p-4">
            <TriangleAlert className="mt-0.5 h-5 w-5 flex-none text-amber-950" aria-hidden="true" />
            <div className="flex min-w-0 flex-col gap-0.5">
              <Text color="inherit" size="base" weight="semibold" className="text-amber-950">{t('admin.custos.stale')}</Text>
              <Text color="inherit" size="sm" className="text-amber-950">{t('admin.custos.staleDetail', { date: formatDateTime(dados.dataUntil ?? '', lang) })}</Text>
            </div>
          </div>
        )}

        {!sincronizando && vazio && dados && (
          <section data-testid="custos-vazio" className={`${CARD} flex min-h-[240px] flex-col items-center justify-center gap-4 text-center`}>
            <Heading level={2} weight="semibold">{t('admin.custos.empty.title', { month: capitalize(monthLabel(dados.month, lang)) })}</Heading>
            <Text color="tertiary" size="sm">{t('admin.custos.empty.text')}</Text>
            {ultimoComDados && (
              <Button variant="outline" size="lg" data-testid="custos-ver-ultimo" onClick={() => escolher(ultimoComDados)}>
                <span className="whitespace-nowrap" data-single-line="selo">{t('admin.custos.empty.seeLast', { month: monthLabel(ultimoComDados, lang) })}</span>
              </Button>
            )}
          </section>
        )}

        {!sincronizando && dados !== null && !vazio && (
          <div className="flex min-w-0 flex-col gap-6" data-testid="custos-resultado">
            {item ? (
              <CustosDetalhe ov={dados} item={item} onVoltar={() => { voltarPara.current = item.name; setDetalhe(null); }} />
            ) : (
              <>
                <CustosVeredito ov={dados} onDetalhe={(i) => setDetalhe({ kind: i.kind, name: i.name })} />
                <CustosKpis ov={dados} />
                <CustosQuemGasta ov={dados} />
                <CustosMeses ov={dados} />
              </>
            )}
          </div>
        )}
      </div>
    </PageContainer>
  );
}
