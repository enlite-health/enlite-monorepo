import { useTranslation } from 'react-i18next';
import type { PatientAddressDetail } from '@domain/entities/PatientDetail';
import {
  patientAddressLabel,
  SERVICE_CODES,
  CARE_LOCATIONS,
  CONTRACT_TYPES,
  TAX_CONDITIONS,
  SUPERVISION_FREQUENCIES,
  GUARD_SHIFTS,
  PROVIDER_AGE_BANDS,
} from '@domain/entities/PatientContractedService';
import { DEVICE_TYPE_CODES } from '@domain/entities/patientEnums';
import type { SelectOption } from '@presentation/components/molecules/SelectField';

const CARD = 'admin.patients.detail.contractedServicesCard';

/**
 * Opções dos selects do formulário de serviço contratado (`ContractedServiceFormRow`) — extraído
 * quando o formulário passou do teto de 400 linhas com o endereço e o horário (migration 330).
 * Enum NUNCA chega cru à tela: cada valor passa por i18n com fallback no valor.
 */
export function useContractedServiceOptions(addresses: PatientAddressDetail[]) {
  const { t } = useTranslation();
  const enumOptions = (values: readonly string[], group: string): SelectOption[] =>
    values.map((v) => ({ value: v, label: t(`${CARD}.${group}.${v}`, { defaultValue: v }) }));

  return {
    serviceOptions: enumOptions(SERVICE_CODES, 'serviceTypes'),
    careLocationOptions: enumOptions(CARE_LOCATIONS, 'careLocationOptions'),
    contractTypeOptions: enumOptions(CONTRACT_TYPES, 'contractTypeOptions'),
    taxConditionOptions: enumOptions(TAX_CONDITIONS, 'taxConditionOptions'),
    supervisionOptions: enumOptions(SUPERVISION_FREQUENCIES, 'supervisionFrequencyOptions'),
    guardShiftOptions: enumOptions(GUARD_SHIFTS, 'guardShiftOptions'),
    providerAgeBandOptions: enumOptions(PROVIDER_AGE_BANDS, 'providerAgeBandOptions'),
    deviceOptions: DEVICE_TYPE_CODES.map((v) => ({
      value: v,
      label: t(`admin.patients.deviceTypeOptions.${v}`, { defaultValue: v }),
    })) as SelectOption[],
    // Migration 330: só endereços VIVOS da ficha. Um serviço cujo endereço foi arquivado chega com
    // `addressId` fora desta lista — o select mostra vazio e o checklist acusa SERVICE_ADDRESS.
    addressOptions: addresses.map((a) => ({ value: a.id, label: patientAddressLabel(a) })) as SelectOption[],
  };
}
