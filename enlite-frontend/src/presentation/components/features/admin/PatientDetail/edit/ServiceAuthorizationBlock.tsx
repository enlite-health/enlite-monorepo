import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import type { ContractedServiceAuthorization, PatientContractedServiceDetail } from '@domain/entities/PatientContractedService';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';

interface Props {
  patientId: string;
  service: PatientContractedServiceDetail;
  index: number;
}

const ERROR_KEY: Record<string, string> = {
  AUTHORIZATION_OVERLAPS: 'overlaps',
  AUTHORIZATION_NEEDS_END: 'needsEnd',
};

/**
 * Bloco "Autorización" do serviço (spec 056 §7): horas autorizadas com vigência. Salva SOZINHO
 * (POST; supersede quando já há vigente) — não entra no PATCH do serviço, que recusa o campo legado.
 * `validTo` é INCLUSIVO, enviado como digitado. Sem vigente: "sin autorización" (o valor antigo da coluna é snapshot e não é mais lido — 058 B, P7).
 */
export function ServiceAuthorizationBlock({ patientId, service, index }: Props): JSX.Element {
  const { t } = useTranslation();
  const ta = (k: string, o?: Record<string, unknown>) => t(`admin.patients.editDrawer.authorization.${k}`, o);
  const [current, setCurrent] = useState<ContractedServiceAuthorization | null>(service.authorization);
  const [hours, setHours] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const hoursNum = Number(hours);
  const canSave = hours.trim() !== '' && hoursNum > 0 && from !== '' && !busy;

  const save = async (): Promise<void> => {
    setErrorKey(null);
    if (to === '') {
      setErrorKey('needsEnd');
      return;
    }
    setBusy(true);
    try {
      const body = { hours: hoursNum, validFrom: from, validTo: to };
      const saved = current
        ? await AdminContractedServicesApiService.supersedeAuthorization(patientId, service.id, current.id, body)
        : await AdminContractedServicesApiService.createAuthorization(patientId, service.id, body);
      setCurrent(saved);
      setHours('');
      setFrom('');
      setTo('');
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      setErrorKey((code && ERROR_KEY[code]) || 'saveError');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid={`svc-auth-block-${index}`}>
      <Text size="sm" weight="semibold" color="secondary">{ta('title')}</Text>
      {current ? (
        <Text size="sm" data-testid={`svc-auth-current-${index}`}>
          {ta('current', { hours: current.hours, from: current.validFrom, to: current.validTo })}
        </Text>
      ) : (
        <Text size="sm" data-testid={`svc-auth-none-${index}`}>{ta('none')}</Text>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FormField label={ta('hours')} htmlFor={`svc-auth-hours-${index}`}>
          <InputWithIcon id={`svc-auth-hours-${index}`} type="number" min={0} step="any" inputSize="compact" value={hours} onChange={(e) => setHours(e.target.value)} data-testid={`svc-auth-hours-${index}`} />
        </FormField>
        <FormField label={ta('from')} htmlFor={`svc-auth-from-${index}`}>
          <InputWithIcon id={`svc-auth-from-${index}`} type="date" inputSize="compact" value={from} onChange={(e) => setFrom(e.target.value)} data-testid={`svc-auth-from-${index}`} />
        </FormField>
        <FormField label={ta('to')} htmlFor={`svc-auth-to-${index}`}>
          <InputWithIcon id={`svc-auth-to-${index}`} type="date" inputSize="compact" value={to} onChange={(e) => setTo(e.target.value)} data-testid={`svc-auth-to-${index}`} />
        </FormField>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={save} isLoading={busy} disabled={!canSave} data-testid={`svc-auth-save-${index}`}>
          {ta('save')}
        </Button>
        {errorKey && <Text size="sm" className="text-red-600" data-testid={`svc-auth-error-${index}`}>{ta(errorKey)}</Text>}
      </div>
    </div>
  );
}
