import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import type { ContractedServicePayerHistoryItem } from '@domain/entities/PatientContractedService';
import { Text } from '@presentation/components/atoms/Text';
import { formatCalendarDate } from '@presentation/utils/dateTimeFormat';
import { contractedServicePriceText, contractedServiceTaxText } from '../contractedServicePriceText';
import { CoverageMatchNotice } from '../CoverageMatchNotice';

const CARD = 'admin.patients.detail.contractedServicesCard';
const EYEBROW = 'font-lexend text-[11px] font-medium uppercase tracking-[0.08em] text-primary';
const PAIR_LABEL = 'font-lexend text-[11px] uppercase tracking-[0.04em] text-primary';

interface Props {
  service: PatientContractedServiceDetail;
  /** Vínculo vivo hoje (`payer.state === 'LINKED'`). */
  linked: Extract<PatientContractedServiceDetail['payer'], { state: 'LINKED' }> | null;
  /** Vínculo que só começa depois do `asOf` (o `payer` diz NO_CONTRACT, mas ele existe). */
  scheduled: ContractedServicePayerHistoryItem | null;
  /** Botões da situação (mudar / vincular / criar serviço novo) — quem decide as condições é o painel. */
  actions: ReactNode;
}

function Pair({ label, children, testId }: { label: string; children: ReactNode; testId?: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 min-w-0" data-testid={testId}>
      <span className={PAIR_LABEL}>{label}</span>
      {children}
    </div>
  );
}

/**
 * O cartão "o que vale hoje" do serviço (spec 058, opção A aprovada em 21/10/2026): a obra social em destaque, o contrato embaixo,
 * a vigência, o selo da divergência com a cobertura verificada e os pares Valor / Impuesto / Tipo. Só EXIBE: preço e imposto vêm do
 * termo vigente. Os testids `svc-payer*`, `svc-price`, `svc-tax`, `svc-coverage-match` são os de sempre (os e2e localizam por eles).
 */
export function ContractedServiceCoverageSummary({ service, linked, scheduled, actions }: Props): JSX.Element {
  const { t, i18n } = useTranslation();
  const date = (d: string | null | undefined): string => formatCalendarDate(d, {}) ?? '';
  const live = linked ?? scheduled;
  const names = live?.names ?? null;
  const history = service.payerHistory;
  const future = linked ? [...history].filter((h) => h.validFrom > service.asOf).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0] ?? null : null;
  const last = !live ? ([...history].sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0] ?? null) : null;

  // Sem vínculo nenhum (nem vivo, nem programado, nem histórico): estado vazio, sem valor nem imposto inventados.
  if (!live && !last) {
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-dashed border-[#b9b4cc] p-4" data-testid="svc-payer" data-state={service.payer.state}>
        <span className={EYEBROW}>{t(`${CARD}.contractSection`)}</span>
        <Text size="base" weight="semibold" color="primary">{t(`${CARD}.summary.emptyTitle`)}</Text>
        <Text size="sm" color="tertiary">{t(`${CARD}.summary.emptyBody`)}</Text>
        <div className="grid grid-cols-1 gap-2 pt-1 sm:flex sm:flex-wrap">{actions}</div>
      </div>
    );
  }

  // Tinha vínculo e terminou: o último, sem preço (o termo vigente não existe).
  if (!live && last) {
    const lastNames = last.names;
    const lastName = lastNames
      ? (last.validTo
        ? t(`${CARD}.summary.lastLink`, { provider: lastNames.providerName, contract: lastNames.contractName, date: date(last.validTo) })
        : `${lastNames.providerName} · ${lastNames.contractName}`)
      : (last.isPrivate ? t(`${CARD}.payer.private`) : t(`${CARD}.payer.hidden`));
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-[#D9D9D9] p-4" data-testid="svc-payer" data-state={service.payer.state}>
        <span className={EYEBROW}>{t(`${CARD}.summary.noCoverage`)}</span>
        <Text size="base" weight="semibold" color="primary">{lastName}</Text>
        <div className="grid grid-cols-1 gap-2 pt-1 sm:flex sm:flex-wrap">{actions}</div>
      </div>
    );
  }

  const headline = names ? names.providerName : (live?.isPrivate ? t(`${CARD}.payer.private`) : t(`${CARD}.payer.hidden`));

  return (
    <div className="flex flex-col gap-3 rounded-xl border-[1.5px] border-primary bg-[#faf9fe] p-4" data-testid="svc-payer" data-state={service.payer.state}>
      <span className={EYEBROW}>{linked ? t(`${CARD}.summary.eyebrow`, { date: date(service.asOf) }) : t(`${CARD}.contractSection`)}</span>
      <div className="flex flex-col gap-0.5">
        <Text size="lg" weight="semibold" color="primary" data-testid="svc-payer-provider">{headline}</Text>
        {names && <Text size="sm" weight="medium" color="primary" data-testid="svc-payer-contract">{names.contractName}</Text>}
      </div>
      {linked && (
        <Text size="sm" color="tertiary" data-testid="svc-payer-validity">
          {linked.validTo
            ? t(`${CARD}.summary.sinceUntil`, { from: date(linked.validFrom), to: date(linked.validTo) })
            : t(`${CARD}.summary.since`, { from: date(linked.validFrom) })}
        </Text>
      )}
      {scheduled && (
        <Text size="sm" color="tertiary" data-testid="svc-payer-scheduled">{t(`${CARD}.payer.scheduled`, { date: date(scheduled.validFrom) })}</Text>
      )}
      <div className="flex flex-wrap gap-2">
        <CoverageMatchNotice state={service.coverageMatch.state} badge />
        {future?.names && (
          <span className="font-lexend inline-flex items-center rounded-[14px] border border-[#ccd2fb] bg-[#eef0ff] px-2.5 py-0.5 text-[12.5px] font-medium leading-snug text-[#1e2a78]" data-testid="svc-payer-future">
            {t(`${CARD}.summary.futureChange`, { date: date(future.validFrom), provider: future.names.providerName, contract: future.names.contractName })}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-3 gap-y-2">
        <Pair label={t(`${CARD}.tableValue`)}>
          <Text size="sm" weight="medium" color="tertiary" className="whitespace-nowrap" data-testid="svc-price">{contractedServicePriceText(t, service.price, i18n.language)}</Text>
        </Pair>
        <Pair label={t(`${CARD}.tableIVA`)}>
          <Text size="sm" weight="medium" color="tertiary" className="whitespace-nowrap" data-testid="svc-tax">{contractedServiceTaxText(t, service.tax, i18n.language)}</Text>
        </Pair>
        {names?.payerKind && (
          <Pair label={t(`${CARD}.payerKind`)} testId="svc-payer-kind">
            <Text size="sm" weight="medium" color="tertiary" className="whitespace-nowrap">{t(`${CARD}.payerKindOptions.${names.payerKind}`)}</Text>
          </Pair>
        )}
      </div>
      {actions && <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">{actions}</div>}
    </div>
  );
}
