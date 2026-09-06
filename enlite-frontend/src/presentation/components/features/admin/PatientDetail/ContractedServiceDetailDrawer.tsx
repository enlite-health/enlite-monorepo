import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientAddressDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import { contractedServiceScheduleText } from './contractedServiceScheduleText';

interface Props {
  service: PatientContractedServiceDetail;
  /** Endereços vivos da ficha — resolve `service.addressId` em texto (ponteiro, nada copiado). */
  addresses: PatientAddressDetail[];
  onClose: () => void;
}

const CLOSE_MS = 300;
const CARD = 'admin.patients.detail.contractedServicesCard';
const EMPTY = '—';

function Field({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5" data-testid={testId}>
      <Text size="xs" color="secondary">{label}</Text>
      <Text size="sm" weight="medium">{value}</Text>
    </div>
  );
}

/**
 * Detalhe SÓ-LEITURA de um serviço contratado — abre ao clicar na linha da tabela (decisão do
 * Gabriel 05/09: a tabela mostra o essencial no molde do Figma; "as informações completas caso
 * ele clique no serviço"). Editar continua no drawer de edição (botão "Editar servicios").
 * Enum nunca chega cru: cada valor passa por i18n com fallback no próprio valor.
 */
export function ContractedServiceDetailDrawer({ service, addresses, onClose }: Props): JSX.Element {
  const { t } = useTranslation();
  const tc = (k: string) => t(`${CARD}.${k}`);
  const opt = (group: string, v: string | null) => (v ? t(`${CARD}.${group}.${v}`, { defaultValue: v }) : EMPTY);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const close = (): void => {
    setShow(false);
    setTimeout(onClose, CLOSE_MS);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const address = addresses.find((a) => a.id === service.addressId) ?? null;
  const activeProviders = service.providers.filter((p) => p.active);
  const num = (v: number | null): string => (v == null ? EMPTY : String(v));
  const valueText = service.hourlyValueRedacted
    ? tc('tableValueRedacted')
    : num(service.hourlyValue);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        onClick={close}
        data-testid="contracted-service-detail-backdrop"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tc('detailTitle')}
        className={`fixed top-0 right-0 h-screen z-50 w-full max-w-xl bg-white shadow-2xl rounded-tl-[32px] rounded-bl-[32px] flex flex-col transition-transform duration-300 ease-in-out ${show ? 'translate-x-0' : 'translate-x-full'}`}
        data-testid="contracted-service-detail-drawer"
      >
        <div className="flex items-center justify-between px-8 py-5 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-2">
            <Heading level={3} weight="semibold" color="primary">
              {opt('serviceTypes', service.serviceCode)}
            </Heading>
            {!service.active && (
              <span className="bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">
                <Text as="span" size="xs" weight="medium" color="inherit">{tc('inactiveBadge')}</Text>
              </span>
            )}
          </div>
          <button type="button" onClick={close} aria-label={tc('detailClose')} className="text-slate-400 hover:text-slate-700 transition-colors p-1 rounded" data-testid="contracted-service-detail-close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label={tc('tableDevice')}
              testId="svc-detail-devices"
              value={service.deviceTypes.length > 0
                ? service.deviceTypes.map((d) => t(`admin.patients.deviceTypeOptions.${d}`, { defaultValue: d })).join(', ')
                : EMPTY}
            />
            <Field label={tc('tableProvidersNeeded')} testId="svc-detail-providers-needed" value={num(service.providersNeeded)} />
            <Field label={tc('tableLocation')} testId="svc-detail-location" value={opt('careLocationOptions', service.careLocation)} />
            <Field
              label={tc('tableAddress')}
              testId="svc-detail-address"
              value={address ? patientAddressLabel(address) : tc('noAddressLinked')}
            />
            <div className="sm:col-span-2">
              <Field label={tc('tableSchedule')} testId="svc-detail-schedule" value={contractedServiceScheduleText(service.schedule) ?? tc('noSchedule')} />
            </div>
            <Field label={tc('tableWeeklyHours')} testId="svc-detail-weekly-hours" value={num(service.weeklyHours)} />
            <Field label={tc('tableAuthorizedHours')} testId="svc-detail-authorized-hours" value={num(service.authorizedHours)} />
            <Field label={tc('tableValue')} testId="svc-detail-value" value={valueText} />
            <Field label={tc('tableVersion')} testId="svc-detail-version" value={service.version ?? EMPTY} />
            <Field label={tc('tableStart')} testId="svc-detail-start" value={service.startDate ? new Date(service.startDate).toLocaleDateString() : EMPTY} />
            <Field label={tc('tableContract')} testId="svc-detail-contract" value={opt('contractTypeOptions', service.contractType)} />
            <Field label={tc('tableIVA')} testId="svc-detail-iva" value={opt('taxConditionOptions', service.taxCondition)} />
            <Field label={tc('tableProviderAgeBand')} testId="svc-detail-age-band" value={opt('providerAgeBandOptions', service.providerAgeBand)} />
            <Field label={tc('detailSupervision')} testId="svc-detail-supervision" value={opt('supervisionFrequencyOptions', service.supervisionFrequency)} />
            <Field label={tc('detailGuardShift')} testId="svc-detail-guard-shift" value={opt('guardShiftOptions', service.guardShift)} />
          </div>

          {service.professionalProfile && (
            <div className="flex flex-col gap-0.5" data-clarity-mask="True" data-testid="svc-detail-profile">
              <Text size="xs" color="secondary">{tc('detailProfessionalProfile')}</Text>
              <Text size="sm" className="whitespace-pre-wrap">{service.professionalProfile}</Text>
            </div>
          )}

          <div className="flex flex-col gap-2" data-testid="svc-detail-providers">
            <Text size="xs" color="secondary">
              {tc('detailProviders')} ({activeProviders.length}{service.providersNeeded != null ? ` / ${service.providersNeeded}` : ''})
            </Text>
            {activeProviders.length === 0 ? (
              <Text size="sm" color="muted">{tc('detailNoProviders')}</Text>
            ) : (
              <ul className="flex flex-col gap-1">
                {activeProviders.map((p) => (
                  <li key={p.id} className="flex items-center justify-between border-b border-gray-100 py-1 last:border-b-0">
                    <Text as="span" size="sm" weight="medium">{p.workerName ?? EMPTY}</Text>
                    <Text as="span" size="sm" color="secondary">{p.weeklyHours != null ? `${p.weeklyHours} h` : EMPTY}</Text>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
