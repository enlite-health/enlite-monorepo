import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@presentation/components/atoms/Table';
import { COSTS_NONE_KEY, type CostOverview } from '@infrastructure/http/AdminCostsApiService';
import { formatMoney } from './custosFormat';

const CARD = 'rounded-[20px] border-2 border-[#595959] bg-white p-4 sm:p-5';
const BADGE = 'ml-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold';

function Bloco({ testId, titulo, vazio, heads, children }: {
  testId: string; titulo: string; vazio: boolean; heads: string[]; children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <section data-testid={testId} className={CARD}>
      <h2 className="mb-2 text-sm font-semibold text-[#404040]">{titulo}</h2>
      {vazio ? (
        <p data-testid={`${testId}-vazio`} className="text-sm text-[#404040]">{t('admin.custos.tables.empty')}</p>
      ) : (
        <Table>
          <TableHeader>
            {heads.map((h, i) => <TableHead key={h} align={i === heads.length - 1 ? 'right' : 'left'}>{h}</TableHead>)}
          </TableHeader>
          <TableBody>{children}</TableBody>
        </Table>
      )}
    </section>
  );
}

/** As 4 quebras do mês: serviço GCP, recurso, setor (`__none__` → "sem setor") e chamador de IA (selos "estimado" / "não atribuído"). */
export function CustosTables({ ov }: { ov: CostOverview }): JSX.Element {
  const { t, i18n } = useTranslation();
  const money = (v: number) => formatMoney(v, ov.currency, i18n?.language);
  const col = (k: string) => t(`admin.custos.columns.${k}`);

  return (
    <div className="space-y-4">
      <Bloco testId="custos-por-servico" titulo={t('admin.custos.tables.service')} vazio={ov.byService.length === 0} heads={[col('service'), col('cost')]}>
        {ov.byService.map((r) => (
          <TableRow key={r.service}><TableCell>{r.service}</TableCell><TableCell align="right">{money(r.total)}</TableCell></TableRow>
        ))}
      </Bloco>

      <Bloco testId="custos-por-recurso" titulo={t('admin.custos.tables.resource')} vazio={ov.byResource.length === 0} heads={[col('service'), col('resource'), col('cost')]}>
        {ov.byResource.map((r) => (
          <TableRow key={`${r.service}|${r.resource}`}>
            <TableCell>{r.service}</TableCell>
            <TableCell>{r.resource === COSTS_NONE_KEY ? t('admin.custos.tables.noResource') : r.resource}</TableCell>
            <TableCell align="right">{money(r.total)}</TableCell>
          </TableRow>
        ))}
      </Bloco>

      <Bloco testId="custos-por-setor" titulo={t('admin.custos.tables.sector')} vazio={ov.bySector.length === 0} heads={[col('sector'), col('cost')]}>
        {ov.bySector.map((r) => (
          <TableRow key={r.sector}>
            <TableCell>{r.sector === COSTS_NONE_KEY ? t('admin.custos.tables.noSector') : r.sector}</TableCell>
            <TableCell align="right">{money(r.total)}</TableCell>
          </TableRow>
        ))}
      </Bloco>

      <Bloco testId="custos-por-chamador" titulo={t('admin.custos.tables.aiCaller')} vazio={ov.byAiCaller.length === 0} heads={[col('caller'), col('function'), col('cost')]}>
        {ov.byAiCaller.map((r) => (
          <TableRow key={`${r.caller}|${r.funcao}|${r.source}`}>
            <TableCell unwrapped>
              <span className="text-sm text-[#1A1A1A]">{r.caller === COSTS_NONE_KEY ? t('admin.custos.tables.noCaller') : r.caller}</span>
              {r.source === 'estimated' && <span data-testid="custos-selo-estimado" className={`${BADGE} bg-[#F5ECD6] text-[#4A3300]`}>{t('admin.custos.badges.estimated')}</span>}
              {r.source === 'unattributed' && <span data-testid="custos-selo-nao-atribuido" className={`${BADGE} bg-[#F4E4E4] text-[#5C0A0A]`}>{t('admin.custos.badges.unattributed')}</span>}
            </TableCell>
            <TableCell>{r.funcao === COSTS_NONE_KEY ? t('admin.custos.tables.noCaller') : r.funcao}</TableCell>
            <TableCell align="right">{money(r.total)}</TableCell>
          </TableRow>
        ))}
      </Bloco>
    </div>
  );
}

/** Anomalias do dia (RF-8). Menos de 7 dias de dado: "histórico insuficiente"; `isNew` vira selo "novo"; fator nulo mostra "—". */
export function CustosAnomalias({ ov }: { ov: CostOverview }): JSX.Element {
  const { t, i18n } = useTranslation();
  const money = (v: number) => formatMoney(v, ov.currency, i18n?.language);
  const { status, items } = ov.anomalies;
  const col = (k: string) => t(`admin.custos.columns.${k}`);
  return (
    <section data-testid="custos-anomalias" className={CARD}>
      <h2 className="mb-2 text-sm font-semibold text-[#404040]">{t('admin.custos.anomalies.title')}</h2>
      {status === 'insufficient_history' ? (
        <p data-testid="custos-anomalias-insuficiente" className="text-sm text-[#404040]">{t('admin.custos.anomalies.insufficient')}</p>
      ) : items.length === 0 ? (
        <p data-testid="custos-anomalias-vazio" className="text-sm text-[#404040]">{t('admin.custos.anomalies.none')}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableHead>{col('kind')}</TableHead>
            <TableHead>{col('name')}</TableHead>
            <TableHead align="right">{col('dayValue')}</TableHead>
            <TableHead align="right">{col('median7')}</TableHead>
            <TableHead align="right">{col('factor')}</TableHead>
          </TableHeader>
          <TableBody>
            {items.map((a) => (
              <TableRow key={`${a.kind}|${a.name}`} data-testid="custos-anomalia">
                <TableCell>{t(`admin.custos.anomalies.kind.${a.kind}`)}</TableCell>
                <TableCell unwrapped>
                  <span className="text-sm text-[#1A1A1A]">{a.name}</span>
                  {a.isNew && <span data-testid="custos-selo-novo" className={`${BADGE} bg-[#E6F0FF] text-[#0B2E6B]`}>{t('admin.custos.badges.new')}</span>}
                </TableCell>
                <TableCell align="right">{money(a.dayValue)}</TableCell>
                <TableCell align="right">{money(a.median7)}</TableCell>
                <TableCell align="right">{a.factor === null ? t('admin.custos.cards.noValue') : `${new Intl.NumberFormat(i18n?.language === 'pt-BR' ? 'pt-BR' : 'es-AR', { maximumFractionDigits: 1 }).format(a.factor)}×`}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
