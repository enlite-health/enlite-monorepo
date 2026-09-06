import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientAddressDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import type { ContractedServiceScheduleSlot } from '@domain/entities/PatientContractedService';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField } from '@presentation/components/molecules/SelectField';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { DayScheduleEditor } from '@presentation/components/molecules/DayScheduleEditor';
import { ContractedServiceProvidersSection } from './ContractedServiceProvidersSection';
import { useContractedServiceOptions } from './useContractedServiceOptions';

interface Props {
  patientId: string;
  /**
   * Endereços VIVOS da ficha (`patient.addresses`) — o select "Domicilio" escolhe UM deles
   * (migration 330: um serviço = um endereço; ponteiro, nada é copiado). Lista vazia → o select
   * fica desabilitado com a dica de cadastrar o domicílio primeiro.
   */
  addresses: PatientAddressDetail[];
  service: PatientContractedServiceDetail | null;
  /** Index visual ("Serviço 1", "Serviço 2"…) — só para o rótulo, nunca enviado. */
  index: number;
  onSaved: () => void;
  onCancelNew?: () => void;
  /** Spec 014 (US-D4): avisa o pai (`PatientContractedServicesEditDrawer`) sempre que ESTA
   * linha tem mudança não salva — o drawer não tem "Guardar" próprio (cada linha salva sozinha,
   * ver docblock do pai), então o "dirty" que decide a confirmação de fechar é a UNIÃO do dirty
   * de todas as linhas + o formulário "+ Nuevo servicio" em aberto. */
  onDirtyChange?: (dirty: boolean) => void;
}

// Todos os campos numéricos ficam STRING no formulário (molde dos demais drawers do painel —
// `PatientSupportNetworkEditDrawer` etc.): a conversão pra number|null acontece em `onSubmit`,
// nunca no schema — um `.transform()` no zod faz o tipo de ENTRADA do form divergir do de
// SAÍDA, e `useForm<FormValues>` só aceita um dos dois.
const numericString = z.string().refine((v) => v.trim() === '' || !Number.isNaN(Number(v)), 'invalid number');

const schema = z.object({
  // Spec 014 (US-D4): chave i18n como mensagem (mesmo padrão de PatientSupportNetworkEditDrawer/
  // workerRegistrationSchemas.ts) — sem ela o zodResolver caía no default em inglês do zod.
  serviceCode: z.string().min(1, 'admin.patients.editDrawer.requiredField'),
  professionalProfile: z.string(),
  providersNeeded: numericString,
  authorizedHours: numericString,
  weeklyHours: numericString,
  careLocation: z.string(),
  hourlyValue: numericString,
  version: z.string(),
  startDate: z.string(),
  contractType: z.string(),
  taxCondition: z.string(),
  supervisionFrequency: z.string(),
  guardShift: z.string(),
  providerAgeBand: z.string(),
  // Migration 330: '' = sem endereço (o checklist acusa SERVICE_ADDRESS; não é erro de form —
  // a operadora pode salvar o serviço antes de ter o domicílio e vincular depois).
  addressId: z.string(),
  // Horário do encuadre — o mesmo slot do DayScheduleEditor. [] = "ainda sem horário" → null.
  schedule: z.array(z.object({ dayOfWeek: z.number(), startTime: z.string(), endTime: z.string() })),
  deviceTypeCodes: z.array(z.string()),
});
type FormValues = z.infer<typeof schema>;

function empty(v: string | number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

function numOrNull(v: string): number | null {
  const s = v.trim();
  return s === '' ? null : Number(s);
}

/** `[]` no formulário é "ainda sem horário" e viaja como `null` (migration 330). */
function scheduleOrNull(slots: ContractedServiceScheduleSlot[]): ContractedServiceScheduleSlot[] | null {
  return slots.length === 0 ? null : slots;
}

export interface DeactivateServiceDeps {
  patientId: string;
  confirmMessage: string;
  setBusy: (busy: boolean) => void;
  /** F4: o canal de erro que o componente JÁ tem — este caminho não o usava. */
  setError: (error: string | null) => void;
  errorMessage: string;
  onSaved: () => void;
}

/**
 * Baixa (`active:false`) do serviço, com confirmação — extraída da closure do componente e
 * EXPORTADA só para teste direto (QA-caça #4): o botão que chama isto só renderiza quando
 * `!isNew && service.active`, ou seja, `service` já vem garantido não-null pela JSX — o guarda
 * `if (!service) return` abaixo é por isso INALCANÇÁVEL por qualquer clique simulado (o elemento
 * nem existe no DOM quando `service` é null). Chamar esta função diretamente com `service=null`
 * é o único jeito de exercitar essa branch.
 */
// eslint-disable-next-line react-refresh/only-export-components -- exportado só para teste direto (QA-caça #4), ver docblock acima.
export async function deactivateService(
  service: PatientContractedServiceDetail | null,
  deps: DeactivateServiceDeps,
): Promise<void> {
  if (!service) return;
  if (!window.confirm(deps.confirmMessage)) return;
  deps.setError(null);
  deps.setBusy(true);
  try {
    await AdminContractedServicesApiService.updateContractedService(deps.patientId, service.id, { active: false });
    deps.onSaved();
  } catch {
    // F4: `try/finally` SEM `catch` — a operadora confirmava a baixa, o PATCH falhava, e o único
    // sinal era o spinner parando. O `setError` já existia e era renderizado na linha do Salvar;
    // este caminho é que nunca o usava.
    deps.setError(deps.errorMessage);
  } finally {
    deps.setBusy(false);
  }
}

/**
 * Formulário de UM serviço contratado — cria (POST) quando `service` é `null`, atualiza
 * (PATCH, Merge Patch parcial) quando existe. `hourlyValue` fica DESABILITADO quando o backend
 * redigiu (lex C-c.4) — evita o operador não-admin sobrescrever um valor que não pode ver.
 */
export function ContractedServiceFormRow({ patientId, addresses, service, index, onSaved, onCancelNew, onDirtyChange }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const isNew = service === null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { register, handleSubmit, control, reset, formState: { isDirty } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      serviceCode: service?.serviceCode ?? '',
      professionalProfile: service?.professionalProfile ?? '',
      providersNeeded: empty(service?.providersNeeded),
      authorizedHours: empty(service?.authorizedHours),
      weeklyHours: empty(service?.weeklyHours),
      careLocation: service?.careLocation ?? '',
      hourlyValue: empty(service?.hourlyValue),
      version: service?.version ?? '',
      startDate: service?.startDate ? service.startDate.slice(0, 10) : '',
      contractType: service?.contractType ?? '',
      taxCondition: service?.taxCondition ?? '',
      supervisionFrequency: service?.supervisionFrequency ?? '',
      guardShift: service?.guardShift ?? '',
      providerAgeBand: service?.providerAgeBand ?? '',
      // Só um endereço VIVO da ficha entra como valor inicial: um `addressId` arquivado não
      // aparece no select e, se ficasse no form, o PATCH reenviaria o UUID morto que a tela
      // mostra como "vazio" (gate, 06/09). Fora da lista → '' → salvar sem escolher manda null.
      addressId: addresses.some((a) => a.id === service?.addressId) ? String(service?.addressId) : '',
      schedule: service?.schedule ?? [],
      deviceTypeCodes: service?.deviceTypes ?? [],
    },
  });

  useEffect(() => {
    onDirtyChange?.(isDirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  const {
    serviceOptions, careLocationOptions, contractTypeOptions, taxConditionOptions,
    supervisionOptions, guardShiftOptions, deviceOptions, providerAgeBandOptions, addressOptions,
  } = useContractedServiceOptions(addresses);

  const onSubmit = async (values: FormValues): Promise<void> => {
    setError(null);
    setBusy(true);
    const nz = (v: string): string | null => (v.trim() ? v.trim() : null);
    try {
      if (isNew) {
        await AdminContractedServicesApiService.createContractedService(patientId, {
          serviceCode: values.serviceCode as never,
          professionalProfile: nz(values.professionalProfile),
          providersNeeded: numOrNull(values.providersNeeded),
          authorizedHours: numOrNull(values.authorizedHours),
          weeklyHours: numOrNull(values.weeklyHours),
          careLocation: nz(values.careLocation) as never,
          hourlyValue: numOrNull(values.hourlyValue),
          version: nz(values.version),
          startDate: nz(values.startDate),
          contractType: nz(values.contractType) as never,
          taxCondition: nz(values.taxCondition) as never,
          supervisionFrequency: nz(values.supervisionFrequency) as never,
          guardShift: nz(values.guardShift) as never,
          providerAgeBand: nz(values.providerAgeBand) as never,
          addressId: nz(values.addressId),
          schedule: scheduleOrNull(values.schedule),
          deviceTypeCodes: values.deviceTypeCodes,
        });
      } else {
        await AdminContractedServicesApiService.updateContractedService(patientId, service.id, {
          professionalProfile: nz(values.professionalProfile),
          providersNeeded: numOrNull(values.providersNeeded),
          authorizedHours: numOrNull(values.authorizedHours),
          weeklyHours: numOrNull(values.weeklyHours),
          careLocation: nz(values.careLocation) as never,
          // Campo desabilitado (redigido) nunca entra no submit — ver `disabled` abaixo; quando
          // habilitado, envia o que o operador digitou (inclusive limpar → null).
          hourlyValue: service.hourlyValueRedacted ? undefined : numOrNull(values.hourlyValue),
          version: nz(values.version),
          startDate: nz(values.startDate),
          contractType: nz(values.contractType) as never,
          taxCondition: nz(values.taxCondition) as never,
          supervisionFrequency: nz(values.supervisionFrequency) as never,
          guardShift: nz(values.guardShift) as never,
          providerAgeBand: nz(values.providerAgeBand) as never,
          addressId: nz(values.addressId),
          schedule: scheduleOrNull(values.schedule),
          deviceTypeCodes: values.deviceTypeCodes,
        });
      }
      // Marca o formulário como "limpo de novo" (o `defaultValues` capturado no mount não
      // muda sozinho quando o pai reidrata `service` depois do refetch — sem isto, `isDirty`
      // ficaria `true` para sempre após a 1ª edição salva, e a confirmação de "descartar
      // cambios" apareceria ao fechar mesmo sem NADA pendente).
      reset(values);
      onSaved();
    } catch {
      setError(isNew ? te('createServiceError') : te('updateServiceError'));
    } finally {
      setBusy(false);
    }
  };

  const deactivate = (): Promise<void> =>
    deactivateService(service, {
      patientId,
      confirmMessage: te('deactivateServiceConfirm'),
      setBusy,
      setError,
      errorMessage: te('deactivateServiceError'),
      onSaved,
    });

  return (
    <div
      className="flex flex-col gap-3 p-4 rounded-xl border border-slate-200"
      data-testid={isNew ? 'contracted-service-new' : `contracted-service-form-${service.id}`}
    >
      <div className="flex items-center justify-between">
        <Text size="sm" weight="semibold" color="secondary">
          {te('contractedServiceHeading').replace('{{n}}', String(index))}
          {service && !service.active && ` — ${te('inactiveBadge')}`}
        </Text>
        <div className="flex items-center gap-2">
          {isNew && onCancelNew && (
            <button type="button" onClick={onCancelNew} aria-label={te('close')} data-testid="contracted-service-new-cancel" className="text-slate-400 hover:text-slate-700 p-1 rounded">
              <Trash2 className="w-4 h-4" />
            </button>
          )}
          {!isNew && service.active && (
            <Button type="button" variant="outline" size="sm" onClick={deactivate} isLoading={busy} data-testid={`contracted-service-deactivate-${service.id}`}>
              {te('deactivateService')}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField label={te('selectServiceCode')} htmlFor={`svc-code-${index}`} required>
          <Controller control={control} name="serviceCode" render={({ field }) => (
            <SelectField id={`svc-code-${index}`} inputSize="compact" options={serviceOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} disabled={!isNew} data-testid={`svc-code-${index}`} />
          )} />
        </FormField>
        <FormField label={te('providersNeeded')} htmlFor={`svc-providersNeeded-${index}`} optional>
          <InputWithIcon id={`svc-providersNeeded-${index}`} type="number" inputSize="compact" data-testid={`svc-providersNeeded-${index}`} {...register('providersNeeded')} />
        </FormField>
        <FormField label={te('weeklyHours')} htmlFor={`svc-weeklyHours-${index}`} optional>
          <InputWithIcon id={`svc-weeklyHours-${index}`} type="number" inputSize="compact" data-testid={`svc-weeklyHours-${index}`} {...register('weeklyHours')} />
        </FormField>
        <FormField label={te('authorizedHours')} htmlFor={`svc-authorizedHours-${index}`} optional>
          <InputWithIcon id={`svc-authorizedHours-${index}`} type="number" inputSize="compact" data-testid={`svc-authorizedHours-${index}`} {...register('authorizedHours')} />
        </FormField>
        <FormField label={te('careLocation')} htmlFor={`svc-careLocation-${index}`} optional>
          <Controller control={control} name="careLocation" render={({ field }) => (
            <SelectField id={`svc-careLocation-${index}`} inputSize="compact" options={careLocationOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-careLocation-${index}`} />
          )} />
        </FormField>
        {/* Migration 330: o ENDEREÇO (ponteiro para a ficha) é distinto do "lugar" (Casa/Escola)
            e do dispositivo — três coisas, como no Figma. Sem ele a vaga não sabe onde nascer. */}
        <FormField
          label={te('serviceAddress')}
          htmlFor={`svc-addressId-${index}`}
          hint={addresses.length === 0 ? te('serviceAddressNoneHint') : te('serviceAddressHint')}
        >
          <Controller control={control} name="addressId" render={({ field }) => (
            <SelectField
              id={`svc-addressId-${index}`}
              inputSize="compact"
              options={addressOptions}
              placeholder={te('selectPlaceholder')}
              value={field.value}
              onChange={field.onChange}
              disabled={addresses.length === 0}
              data-testid={`svc-addressId-${index}`}
            />
          )} />
        </FormField>
        <FormField label={te('hourlyValue')} htmlFor={`svc-hourlyValue-${index}`} optional>
          {service?.hourlyValueRedacted ? (
            <InputWithIcon id={`svc-hourlyValue-${index}`} inputSize="compact" value={te('hourlyValueRedacted')} disabled data-testid={`svc-hourlyValue-${index}`} />
          ) : (
            <InputWithIcon id={`svc-hourlyValue-${index}`} type="number" inputSize="compact" data-testid={`svc-hourlyValue-${index}`} {...register('hourlyValue')} />
          )}
        </FormField>
        <FormField label={te('version')} htmlFor={`svc-version-${index}`} hint={te('versionHint')} optional>
          <InputWithIcon id={`svc-version-${index}`} inputSize="compact" data-testid={`svc-version-${index}`} {...register('version')} />
        </FormField>
        <FormField label={te('startDate')} htmlFor={`svc-startDate-${index}`} optional>
          <InputWithIcon id={`svc-startDate-${index}`} type="date" inputSize="compact" data-testid={`svc-startDate-${index}`} {...register('startDate')} />
        </FormField>
        <FormField label={te('contractType')} htmlFor={`svc-contractType-${index}`} optional>
          <Controller control={control} name="contractType" render={({ field }) => (
            <SelectField id={`svc-contractType-${index}`} inputSize="compact" options={contractTypeOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-contractType-${index}`} />
          )} />
        </FormField>
        <FormField label={te('taxCondition')} htmlFor={`svc-taxCondition-${index}`} optional>
          <Controller control={control} name="taxCondition" render={({ field }) => (
            <SelectField id={`svc-taxCondition-${index}`} inputSize="compact" options={taxConditionOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-taxCondition-${index}`} />
          )} />
        </FormField>
        <FormField label={te('supervisionFrequency')} htmlFor={`svc-supervisionFrequency-${index}`} optional>
          <Controller control={control} name="supervisionFrequency" render={({ field }) => (
            <SelectField id={`svc-supervisionFrequency-${index}`} inputSize="compact" options={supervisionOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-supervisionFrequency-${index}`} />
          )} />
        </FormField>
        <FormField label={te('guardShift')} htmlFor={`svc-guardShift-${index}`} optional>
          <Controller control={control} name="guardShift" render={({ field }) => (
            <SelectField id={`svc-guardShift-${index}`} inputSize="compact" options={guardShiftOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-guardShift-${index}`} />
          )} />
        </FormField>
        <FormField label={te('providerAgeBand')} htmlFor={`svc-providerAgeBand-${index}`} optional>
          <Controller control={control} name="providerAgeBand" render={({ field }) => (
            <SelectField id={`svc-providerAgeBand-${index}`} inputSize="compact" options={providerAgeBandOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-providerAgeBand-${index}`} />
          )} />
        </FormField>
      </div>

      {/* Migration 330: horário do encuadre — o MESMO editor da vaga (DayScheduleEditor). Vazio é
          legítimo: "o operador pode criar uma vacante sem ter horário ainda" (Gabriel 05/09). */}
      <FormField label={te('serviceSchedule')} htmlFor={`svc-schedule-${index}`} optional hint={te('serviceScheduleHint')}>
        <div id={`svc-schedule-${index}`} data-testid={`svc-schedule-${index}`}>
          <Controller control={control} name="schedule" render={({ field }) => (
            <DayScheduleEditor value={field.value} onChange={field.onChange} disabled={busy} />
          )} />
        </div>
      </FormField>

      <FormField label={te('deviceTypes')} htmlFor={`svc-devices-${index}`} optional>
        <Controller control={control} name="deviceTypeCodes" render={({ field }) => (
          <MultiSelect options={deviceOptions} value={field.value} onChange={field.onChange} placeholder={te('selectPlaceholder')} id={`svc-devices-${index}`} />
        )} />
      </FormField>

      <FormField label={te('professionalProfile')} htmlFor={`svc-profile-${index}`} optional hint={te('professionalProfileHint')}>
        <div data-clarity-mask="True">
          <Textarea id={`svc-profile-${index}`} inputSize="compact" resize="vertical" rows={3} data-testid={`svc-profile-${index}`} {...register('professionalProfile')} />
        </div>
      </FormField>

      <div className="flex items-center justify-between">
        <Button type="button" variant="primary" size="sm" onClick={handleSubmit(onSubmit)} isLoading={busy} className="w-32" data-testid={isNew ? 'contracted-service-new-save' : `contracted-service-save-${service.id}`}>
          {te('save')}
        </Button>
        {error && <Text size="sm" className="text-red-600" data-testid={isNew ? 'contracted-service-new-error' : `contracted-service-error-${service?.id}`}>{error}</Text>}
      </div>

      {!isNew && (
        <ContractedServiceProvidersSection patientId={patientId} serviceId={service.id} providers={service.providers} onChanged={onSaved} />
      )}
    </div>
  );
}
