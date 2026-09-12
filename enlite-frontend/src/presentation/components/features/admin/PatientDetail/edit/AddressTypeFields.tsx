import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { SelectField, type SelectOption } from '@presentation/components/molecules/SelectField';
import { Text } from '@presentation/components/atoms/Text';
import { PATIENT_ADDRESS_TYPES, type PatientAddressType } from '@domain/entities/PatientAddress';

/** Teto do texto livre do "Otro" — espelha o CHECK do banco (migration 434). */
export const ADDRESS_TYPE_OTHER_MAX = 40;

interface Props {
  /** `''` representa "sin especificar" (`address_type = NULL`) — o placeholder do `SelectField`. */
  addressType: PatientAddressType | '';
  addressTypeOther: string;
  onAddressTypeChange: (value: PatientAddressType | '') => void;
  onAddressTypeOtherChange: (value: string) => void;
  /** `ta('...')` do drawer — mesmo helper de tradução, sem duplicar o prefixo aqui. */
  ta: (key: string) => string;
  otherError?: string;
}

/**
 * Select de tipo (`pad-type`) + campo "¿Cuál?" do "Otro" (spec 019, US 4.3/4.4). Os dois campos
 * guardam dado sensível sobre a família do paciente (`Escuela` identifica menor de idade, lex
 * art. 10 Ley 26.061) — por isso o wrapper `data-clarity-mask="True"` em cada um, mesmo padrão
 * dos demais campos de endereço nesta tela (`access_notes`, o próprio texto da rua).
 *
 * Extraído do `PatientAddressDrawer.tsx` para não estourar o teto de 400 linhas do arquivo —
 * único consumidor é o drawer, em modo edição (o tipo só existe na coluna reaproveitada,
 * `address_type`, e só entra por PATCH depois da B4 — nunca na criação).
 */
export function AddressTypeFields({
  addressType,
  addressTypeOther,
  onAddressTypeChange,
  onAddressTypeOtherChange,
  ta,
  otherError,
}: Props): JSX.Element {
  const typeOptions: SelectOption[] = PATIENT_ADDRESS_TYPES.map((v) => ({ value: v, label: ta(`type_${v}`) }));
  const isOtro = addressType === 'otro';

  return (
    <>
      <FormField label={ta('type')} htmlFor="pad-type" optional>
        <div data-clarity-mask="True">
          <SelectField
            id="pad-type"
            inputSize="compact"
            options={typeOptions}
            value={addressType}
            onChange={(v) => onAddressTypeChange(v as PatientAddressType | '')}
            data-testid="pad-type"
          />
        </div>
      </FormField>
      {isOtro && (
        <FormField
          label={ta('typeOther')}
          htmlFor="pad-type-other"
          hint={ta('typeOtherHint')}
          hintBelow
          error={otherError}
        >
          <div data-clarity-mask="True" className="flex flex-col gap-1">
            <InputWithIcon
              id="pad-type-other"
              inputSize="compact"
              value={addressTypeOther}
              maxLength={ADDRESS_TYPE_OTHER_MAX}
              onChange={(e) => onAddressTypeOtherChange(e.target.value)}
              aria-invalid={otherError ? 'true' : 'false'}
              data-testid="pad-type-other"
            />
            <Text as="span" size="xs" color="muted" data-testid="pad-type-other-counter">
              {addressTypeOther.length}/{ADDRESS_TYPE_OTHER_MAX}
            </Text>
          </div>
        </FormField>
      )}
    </>
  );
}
