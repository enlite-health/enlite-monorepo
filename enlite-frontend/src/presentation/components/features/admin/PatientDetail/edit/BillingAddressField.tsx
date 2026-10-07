import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { PatientAddressDetail } from '@domain/entities/PatientDetail';
import { deriveBillingLocality } from '@application/use-cases/deriveBillingLocality';
import type { PatientZoneAddressComponent } from '@application/use-cases/derivePatientZone';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { FormField } from '@presentation/components/molecules/FormField';
import { InputWithIcon } from '@presentation/components/molecules/InputWithIcon';
import { useGooglePlacesAutocomplete } from '@presentation/hooks/useGooglePlacesAutocomplete';

/** Os 3 valores do faturamento — viajam sempre juntos (spec 044). */
export interface BillingAddressValue {
  formatted: string;
  city: string | null;
  province: string | null;
}

interface Props {
  value: BillingAddressValue;
  /**
   * `picked` = o valor veio de uma escolha na lista do Google OU de uma cópia do Principal (ou é o valor
   * já gravado, intocado). Digitar à mão devolve `picked = false`: texto sem escolha não grava.
   */
  onChange: (value: BillingAddressValue, picked: boolean) => void;
  /** Lista de endereços do detalhe; `null` quando o ator não lê o container `address`. */
  addresses: PatientAddressDetail[] | null | undefined;
  /** O pai marca quando o salvar foi barrado por texto sem escolha da lista. */
  notPicked: boolean;
}

/**
 * Spec 044 (D475, D1): "Dirección de facturación" do paciente, preenchida pela MESMA busca do Google Places
 * dos locais (`PatientAddressDrawer`): `guessFirstPredictionOnEnter: false` (o chute do Enter gravaria um
 * endereço que a operadora nunca viu), escolha obrigatória, digitar de novo desfaz a escolha. Grava o que o
 * Places devolveu (texto + cidade + província); sem coordenada, sem `place_id`.
 *
 * "Copiar dirección principal": SNAPSHOT do endereço `isPrimary` (nunca `addresses[0]`) para os 3 valores
 * do formulário — só valores, sem guardar id; mudar o Principal depois não muda o faturamento. Só grava ao
 * salvar o drawer. Sem chamada ao Google.
 */
export function BillingAddressField({ value, onChange, addresses, notPicked }: Props): JSX.Element {
  const { t } = useTranslation();
  const te = (k: string) => t(`admin.patients.editDrawer.${k}`);
  const inputRef = useRef<HTMLInputElement>(null);

  const { apiError: autocompleteError } = useGooglePlacesAutocomplete({
    inputRef,
    guessFirstPredictionOnEnter: false,
    onPlaceApplied: (place) => {
      const { city, province } = deriveBillingLocality(
        place.address_components as PatientZoneAddressComponent[] | undefined,
      );
      onChange({ formatted: place.formatted_address as string, city, province }, true);
    },
  });

  const primary = (addresses ?? []).find((a) => a.isPrimary);
  const primaryText = (primary?.addressFormatted ?? primary?.addressRaw ?? '').trim();
  const copyDisabled = !primary || !primaryText;
  const copyTitle = !primary ? te('copyPrimaryNoPrimary') : !primaryText ? te('copyPrimaryNoText') : undefined;

  const copyPrimary = (): void => {
    if (!primary || !primaryText) return;
    onChange({ formatted: primaryText, city: primary.city ?? null, province: primary.state ?? null }, true);
  };

  return (
    <div className="flex flex-col gap-2 sm:col-span-2" data-testid="billing-address-field">
      <FormField
        label={te('billingAddress')}
        htmlFor="pge-billing"
        optional
        hint={te('billingAddressHint')}
        hintBelow
        error={notPicked ? te('billingNotPicked') : undefined}
      >
        {/* Texto de endereço do paciente: o Clarity não grava. A lista de sugestões é mascarada pelo hook. */}
        <div data-clarity-mask="True">
          <InputWithIcon
            ref={inputRef}
            id="pge-billing"
            inputSize="compact"
            value={value.formatted}
            onChange={(e) => onChange({ formatted: e.target.value, city: null, province: null }, false)}
            aria-invalid={notPicked ? 'true' : 'false'}
            data-testid="pge-billing"
          />
        </div>
      </FormField>
      {autocompleteError && (
        <Text size="sm" className="text-amber-700" data-testid="pge-billing-autocomplete-down">
          {t('admin.patients.detail.addressDrawer.addressAutocompleteDown')}
        </Text>
      )}
      <div className="flex">
        {/* `title` num span: botão desabilitado não recebe hover em todo navegador (Firefox/Safari). */}
        <span title={copyTitle}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copyPrimary}
            disabled={copyDisabled}
            title={copyTitle}
            data-testid="pge-billing-copy-primary"
          >
            {te('copyPrimary')}
          </Button>
        </span>
      </div>
    </div>
  );
}
