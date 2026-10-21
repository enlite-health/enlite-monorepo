import { useEffect, useState } from 'react';
import { useForm, Controller, type Control, type UseFormRegister } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import type { PatientAddressDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { Text } from '@presentation/components/atoms/Text';
import { Textarea } from '@presentation/components/atoms/Textarea';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField } from '@presentation/components/molecules/SelectField';
import { MultiSelect } from '@presentation/components/atoms/MultiSelect';
import { ServiceShiftEditor } from './ServiceShiftEditor';
import { shiftsToSlots, slotsToShifts, weeklyHoursOf } from '@domain/scheduleHours';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import { ContractedServiceFormHeader } from './ContractedServiceFormHeader';
import { ContractedServiceFormFooter } from './ContractedServiceFormFooter';
import { FIELD_CELL, FIELD_GRID } from './fieldGrid';
import { ContractedServiceProvidersSection } from './ContractedServiceProvidersSection';
import { ContractedServiceContractPanel } from './ContractedServiceContractPanel';
import { ContractCascade } from './ContractCascade';
import { EMPTY_CASCADE, type ContractCascadeValue } from './contractCascadeValue';
import { AvisoAmbar } from './AvisoAmbar';
import { ServiceAuthorizationBlock } from './ServiceAuthorizationBlock';
import { NumericField } from './NumericField';
import { ContractedServiceRecruitmentFields } from './ContractedServiceRecruitmentFields';
import { recruitmentFormSchema, recruitmentDefaults, recruitmentBody, type RecruitmentFormValues } from './contractedServiceRecruitmentForm';
import { useContractedServiceOptions } from './useContractedServiceOptions';
import { classifySaveError, empty, numOrNull, scheduleOrNull } from './contractedServiceFormHelpers';

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
  /** País do PACIENTE: o serviço novo nasce nele, e a cascata de obra social só lista as do país (serviço existente usa o próprio). */
  patientCountry?: string | null;
  /** Recebe o serviço que a API devolveu (create/update) — o pai não depende de um `list()` para
   *  saber o id do recém-criado. A baixa chama sem argumento. `linkError`: o serviço foi CRIADO, mas o vínculo com o contrato falhou. */
  onSaved: (saved?: PatientContractedServiceDetail, opts?: { linkError?: unknown }) => void;
  /** Vínculo que falhou logo depois de criar este serviço — o painel mostra o erro e a saída. */
  initialLinkError?: unknown;
  /** `REQUIRES_NEW_SERVICE`: o pai abre o formulário de serviço novo. */
  onRequestNewService?: () => void;
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
  careLocation: z.string(),
  startDate: z.string(),
  supervisionFrequency: z.string(),
  guardShift: z.string(),
  providerAgeBand: z.string(),
  // Migration 330: '' = sem endereço (o checklist acusa SERVICE_ADDRESS; não é erro de form —
  // a operadora pode salvar o serviço antes de ter o domicílio e vincular depois).
  addressId: z.string(),
  // Horário do encuadre (spec 056): turnos Inicio/Fin/Todo el día; viaja como durationMinutes. [] = "ainda sem horário" → null.
  schedule: z.array(z.object({ dayOfWeek: z.number(), startTime: z.string(), endTime: z.string(), allDay: z.boolean() })),
  deviceTypeCodes: z.array(z.string()),
  ...recruitmentFormSchema, // spec 027 Fase 3
});
type FormValues = z.infer<typeof schema>;

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
 * Baixa (`active:false`) do serviço, com confirmação — EXPORTADA só para teste direto (QA-caça #4): o botão só renderiza com
 * `service` não-null, então o guarda `if (!service) return` só se exercita chamando esta função com `null`.
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
    // F4: sem `catch` a baixa que falhava só parava o spinner; o erro vai ao canal da linha do Salvar.
    deps.setError(deps.errorMessage);
  } finally {
    deps.setBusy(false);
  }
}

/**
 * Formulário de UM serviço contratado — cria (POST) quando `service` é `null`, atualiza
 * (PATCH, Merge Patch parcial) quando existe. Spec 058: o contrato (obra social -> contrato) é a CASCATA abaixo; preço e
 * imposto vêm do termo vigente e só são exibidos (`ContractedServiceContractPanel`) — não há mais valor-hora nem imposto editável.
 */
export function ContractedServiceFormRow({ patientId, addresses, service, index, patientCountry, onSaved, initialLinkError, onRequestNewService, onCancelNew, onDirtyChange }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const isNew = service === null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shiftsValid, setShiftsValid] = useState(true);
  const [overlap, setOverlap] = useState(false);
  const [addressLocked, setAddressLocked] = useState<'LIVE_VACANCY' | 'ALLOCATION' | null>(null);
  // Só o serviço NOVO escolhe o contrato aqui; o existente tem o painel próprio (vincular / trocar / corrigir / terminar).
  const [cascade, setCascade] = useState<ContractCascadeValue>(EMPTY_CASCADE);

  // Só um endereço VIVO da ficha vale como "salvo" (ver o comentário do defaultValues abaixo).
  const savedAddressId = addresses.some((a) => a.id === service?.addressId) ? String(service?.addressId) : '';
  const { register, handleSubmit, control, reset, watch, setValue, formState: { isDirty } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      serviceCode: service?.serviceCode ?? '',
      professionalProfile: service?.professionalProfile ?? '',
      providersNeeded: empty(service?.providersNeeded),
      careLocation: service?.careLocation ?? '',
      startDate: service?.startDate ? service.startDate.slice(0, 10) : '',
      supervisionFrequency: service?.supervisionFrequency ?? '',
      guardShift: service?.guardShift ?? '',
      providerAgeBand: service?.providerAgeBand ?? '',
      // Só um endereço VIVO da ficha entra como valor inicial: um `addressId` arquivado não
      // aparece no select e, se ficasse no form, o PATCH reenviaria o UUID morto que a tela
      // mostra como "vazio" (gate, 06/09). Fora da lista → '' → salvar sem escolher manda null.
      addressId: savedAddressId,
      schedule: slotsToShifts(service?.schedule ?? []),
      deviceTypeCodes: service?.deviceTypes ?? [],
      ...recruitmentDefaults(service),
    },
  });

  // Total do horário (056): só leitura, calculado do valor ATUAL do editor de turnos — a mesma conta do back.
  const scheduleTotal = weeklyHoursOf(
    watch('schedule').map((x) => (x.allDay ? { startTime: x.startTime, durationMinutes: 1440 } : { startTime: x.startTime, endTime: x.endTime })),
  );

  useEffect(() => {
    onDirtyChange?.(isDirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty]);

  const {
    serviceOptions, careLocationOptions,
    supervisionOptions, guardShiftOptions, deviceOptions, providerAgeBandOptions, addressOptions,
  } = useContractedServiceOptions(addresses);

  const onSubmit = async (values: FormValues): Promise<void> => {
    setError(null);
    setOverlap(false);
    setAddressLocked(null);
    if (!shiftsValid) return;
    // Obra social escolhida sem contrato/início: não cria o serviço pela metade.
    if (isNew && cascade.providerCode && (!cascade.contractId || !cascade.validFrom)) {
      setError(te('contractRequired'));
      return;
    }
    setBusy(true);
    const nz = (v: string): string | null => (v.trim() ? v.trim() : null);
    try {
      let saved: PatientContractedServiceDetail;
      if (isNew) {
        saved = await AdminContractedServicesApiService.createContractedService(patientId, {
          serviceCode: values.serviceCode as never,
          professionalProfile: nz(values.professionalProfile),
          providersNeeded: numOrNull(values.providersNeeded),
          careLocation: nz(values.careLocation) as never,
          startDate: nz(values.startDate),
          supervisionFrequency: nz(values.supervisionFrequency) as never,
          guardShift: nz(values.guardShift) as never,
          providerAgeBand: nz(values.providerAgeBand) as never,
          addressId: nz(values.addressId),
          schedule: scheduleOrNull(shiftsToSlots(values.schedule)),
          deviceTypeCodes: values.deviceTypeCodes,
          ...recruitmentBody(values),
        });
      } else {
        saved = await AdminContractedServicesApiService.updateContractedService(patientId, service.id, {
          professionalProfile: nz(values.professionalProfile),
          providersNeeded: numOrNull(values.providersNeeded),
          careLocation: nz(values.careLocation) as never,
          startDate: nz(values.startDate),
          supervisionFrequency: nz(values.supervisionFrequency) as never,
          guardShift: nz(values.guardShift) as never,
          providerAgeBand: nz(values.providerAgeBand) as never,
          addressId: nz(values.addressId),
          schedule: scheduleOrNull(shiftsToSlots(values.schedule)),
          deviceTypeCodes: values.deviceTypeCodes,
          ...recruitmentBody(values),
        });
      }
      // "Limpo de novo": o `defaultValues` do mount não muda quando o pai reidrata `service`; sem isto `isDirty` ficaria `true` após o 1º save.
      reset(values);
      if (isNew && cascade.contractId) {
        // Serviço criado: agora o vínculo. Se ele falhar, o serviço JÁ existe — o pai troca para o modo edição e o painel mostra o erro.
        try {
          saved = await AdminInsuranceApiService.createContractLink(patientId, saved.id, {
            contractId: cascade.contractId,
            validFrom: cascade.validFrom,
            validTo: cascade.validTo || null,
          });
        } catch (linkError) {
          onSaved(saved, { linkError });
          return;
        }
      }
      onSaved(saved);
    } catch (e) {
      const r = classifySaveError(e);
      if (r.kind === 'overlap') setOverlap(true);
      else if (r.kind === 'addressLocked') {
        setAddressLocked(r.reason);
        // Nada foi gravado: o select volta ao endereço SALVO (não fica mostrando o que a API recusou).
        setValue('addressId', savedAddressId, { shouldDirty: true });
      } else setError(te(r.kind === 'message' ? r.key : isNew ? 'createServiceError' : 'updateServiceError'));
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
      <ContractedServiceFormHeader
        heading={`${te('contractedServiceHeading').replace('{{n}}', String(index))}${service && !service.active ? ` — ${te('inactiveBadge')}` : ''}`}
        serviceId={service?.id ?? null}
        active={service?.active ?? true}
        busy={busy}
        closeLabel={te('close')}
        deactivateLabel={te('deactivateService')}
        onCancelNew={onCancelNew}
        onDeactivate={deactivate}
      />

      {/* Spec 058 (opção A): o bloco de obra social do serviço EXISTENTE sobe para o topo — é o que vale hoje, e a primeira
          coisa que o operador quer ver. Serviço novo: a cascata fica abaixo da grade, onde sempre esteve. */}
      {!isNew && (
        <ContractedServiceContractPanel patientId={patientId} service={service} onChanged={(saved) => onSaved(saved)} onRequestNewService={onRequestNewService} initialError={initialLinkError} />
      )}

      <div className={FIELD_GRID}>
        <FormField labelSize="compact" className={FIELD_CELL} label={te('selectServiceCode')} htmlFor={`svc-code-${index}`} required>
          <Controller control={control} name="serviceCode" render={({ field }) => (
            <SelectField id={`svc-code-${index}`} inputSize="compact" options={serviceOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} disabled={!isNew} data-testid={`svc-code-${index}`} />
          )} />
        </FormField>
        <NumericField cellClassName={FIELD_CELL} id={`svc-providersNeeded-${index}`} label={te('providersNeeded')} testId={`svc-providersNeeded-${index}`} {...register('providersNeeded')} />
        <FormField labelSize="compact" className={FIELD_CELL} label={te('careLocation')} htmlFor={`svc-careLocation-${index}`} optional>
          <Controller control={control} name="careLocation" render={({ field }) => (
            <SelectField id={`svc-careLocation-${index}`} inputSize="compact" options={careLocationOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-careLocation-${index}`} />
          )} />
        </FormField>
        {/* Migration 330: o ENDEREÇO (ponteiro para a ficha) é distinto do "lugar" (Casa/Escola) e do dispositivo. Linha inteira
            (Gabriel, 06/09): decide onde a vaga nasce, e sem endereço na ficha o operador precisa VER o aviso. */}
        <FormField labelSize="compact" className={`${FIELD_CELL} sm:col-span-2`}
          label={te('serviceAddress')}
          htmlFor={`svc-addressId-${index}`}
          hint={addresses.length === 0 ? undefined : te('serviceAddressHint')}
          hintBelow
        >
          {addresses.length === 0 && (
            <AvisoAmbar testId={`svc-address-none-${index}`}>{te('serviceAddressNone')}</AvisoAmbar>
          )}
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
        <FormField labelSize="compact" className={FIELD_CELL} label={te('startDate')} htmlFor={`svc-startDate-${index}`} optional>
          <InputWithIcon id={`svc-startDate-${index}`} type="date" inputSize="compact" data-testid={`svc-startDate-${index}`} {...register('startDate')} />
        </FormField>
        <FormField labelSize="compact" className={FIELD_CELL} label={te('supervisionFrequency')} htmlFor={`svc-supervisionFrequency-${index}`} optional>
          <Controller control={control} name="supervisionFrequency" render={({ field }) => (
            <SelectField id={`svc-supervisionFrequency-${index}`} inputSize="compact" options={supervisionOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-supervisionFrequency-${index}`} />
          )} />
        </FormField>
        <FormField labelSize="compact" className={FIELD_CELL} label={te('guardShift')} htmlFor={`svc-guardShift-${index}`} optional>
          <Controller control={control} name="guardShift" render={({ field }) => (
            <SelectField id={`svc-guardShift-${index}`} inputSize="compact" options={guardShiftOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-guardShift-${index}`} />
          )} />
        </FormField>
        <FormField labelSize="compact" className={FIELD_CELL} label={te('providerAgeBand')} htmlFor={`svc-providerAgeBand-${index}`} optional>
          <Controller control={control} name="providerAgeBand" render={({ field }) => (
            <SelectField id={`svc-providerAgeBand-${index}`} inputSize="compact" options={providerAgeBandOptions} placeholder={te('selectPlaceholder')} value={field.value} onChange={field.onChange} data-testid={`svc-providerAgeBand-${index}`} />
          )} />
        </FormField>
      </div>

      {isNew && (
        <div className="flex flex-col gap-2" data-testid={`svc-contract-new-${index}`}>
          <Text size="sm" weight="semibold" color="secondary">{t('admin.patients.detail.contractedServicesCard.contractSection')}</Text>
          <ContractCascade idPrefix={`svc-contract-${index}`} country={patientCountry} value={cascade} onChange={setCascade} disabled={busy} />
        </div>
      )}

      {/* Horário do encuadre: opcional (salvar vazio é legítimo, Gabriel 05/09); sem horário o paciente não
          muda de status (07/09) — daí o aviso âmbar. Spec 056: turnos Inicio/Fin/Todo el día. */}
      <FormField labelSize="compact" label={te('serviceSchedule')} htmlFor={`svc-schedule-${index}`} optional hint={te('serviceScheduleHint')} hintBelow>
        <div id={`svc-schedule-${index}`} data-testid={`svc-schedule-${index}`}>
          <Controller control={control} name="schedule" render={({ field }) => (
            <>
              {/* `field.value` é SEMPRE array: o defaultValue é `service?.schedule ?? []` e o
                  schema é `z.array(...)` não-nulo — um `?? []` aqui seria ramo inalcançável. */}
              {field.value.length === 0 && (
                <div className="mb-2">
                  <AvisoAmbar testId={`svc-schedule-none-${index}`}>{te('serviceScheduleNone')}</AvisoAmbar>
                </div>
              )}
              <ServiceShiftEditor index={index} value={field.value} onChange={field.onChange} onValidityChange={setShiftsValid} disabled={busy} />
              <Text size="sm" color="secondary" data-testid={`svc-schedule-total-${index}`}>{t('admin.patients.editDrawer.scheduleTotal', { hours: scheduleTotal })}</Text>
              {overlap && <Text size="sm" className="text-red-600" data-testid={`svc-schedule-overlap-${index}`}>{te('scheduleOverlap')}</Text>}
            </>
          )} />
        </div>
      </FormField>

      {!isNew && <ServiceAuthorizationBlock patientId={patientId} service={service} index={index} />}

      <FormField labelSize="compact" label={te('deviceTypes')} htmlFor={`svc-devices-${index}`} optional>
        <Controller control={control} name="deviceTypeCodes" render={({ field }) => (
          <MultiSelect options={deviceOptions} value={field.value} onChange={field.onChange} placeholder={te('selectPlaceholder')} id={`svc-devices-${index}`} />
        )} />
      </FormField>

      <ContractedServiceRecruitmentFields index={index} control={control as unknown as Control<RecruitmentFormValues>} register={register as unknown as UseFormRegister<RecruitmentFormValues>} disabled={busy} />

      <FormField labelSize="compact" label={te('professionalProfile')} htmlFor={`svc-profile-${index}`} optional hint={te('professionalProfileHint')} hintBelow>
        <div data-clarity-mask="True">
          <Textarea id={`svc-profile-${index}`} inputSize="compact" resize="vertical" rows={3} data-testid={`svc-profile-${index}`} {...register('professionalProfile')} />
        </div>
      </FormField>

      <ContractedServiceFormFooter
        serviceId={service?.id ?? null}
        index={index}
        busy={busy}
        saveDisabled={!shiftsValid}
        saveLabel={te('save')}
        onSave={handleSubmit(onSubmit)}
        addressLockedText={addressLocked ? te(addressLocked === 'LIVE_VACANCY' ? 'addressLockedLiveVacancy' : 'addressLockedAllocation') : null}
        error={error}
      />

      {!isNew && (
        <ContractedServiceProvidersSection serviceId={service.id} providers={service.providers} />
      )}
    </div>
  );
}
