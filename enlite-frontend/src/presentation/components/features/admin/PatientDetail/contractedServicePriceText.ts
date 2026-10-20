import type { TFunction } from 'i18next';
import type { ContractedServicePrice, ContractedServiceTax } from '@domain/entities/PatientContractedService';
import type { ContractTermView, TermPrice } from '@domain/entities/InsuranceContract';

const CARD = 'admin.patients.detail.contractedServicesCard';

type PriceLike = ContractedServicePrice | TermPrice;

/**
 * O preço-hora como a tela o mostra. SÓ exibe: o valor vem do termo vigente do contrato (spec 058), nunca de um campo editável.
 * `REDACTED` (sem `patient_contract_value:read`) é um cadeado com a frase — nunca um número, nunca um campo vazio que pareça "sem preço".
 */
export function contractedServicePriceText(t: TFunction, price: PriceLike, language: string): string {
  switch (price.state) {
    case 'OK':
      return `${new Intl.NumberFormat(language, { style: 'currency', currency: price.currency }).format(price.hourlyRate)} / h`;
    case 'REDACTED':
      return t(`${CARD}.priceState.REDACTED`);
    case 'NO_TERM':
      return t(`${CARD}.priceState.NO_TERM`);
    default:
      return t(`${CARD}.priceState.NO_CONTRACT`);
  }
}

/** O imposto do termo vigente. `0` = isento (frase própria, nunca "0 %" solto — o 0 é uma escolha, não a ausência). */
export function contractedServiceTaxText(t: TFunction, tax: ContractedServiceTax, language: string): string {
  switch (tax.state) {
    case 'OK':
      return tax.taxRatePercent === 0
        ? t(`${CARD}.taxExempt`)
        : `${new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(tax.taxRatePercent)} %`;
    case 'NO_TERM':
      return t(`${CARD}.priceState.NO_TERM`);
    default:
      return t(`${CARD}.priceState.NO_CONTRACT`);
  }
}

/** Preço e imposto de um termo da LISTA de contratos (a prévia da cascata) — mesma redação, mesma frase. */
export function contractTermTexts(t: TFunction, term: ContractTermView, language: string): { price: string; tax: string } {
  if (term.state === 'NO_TERM') {
    const none = t(`${CARD}.priceState.NO_TERM`);
    return { price: none, tax: none };
  }
  return {
    price: contractedServicePriceText(t, term.price, language),
    tax: contractedServiceTaxText(t, { state: 'OK', taxRatePercent: term.taxRatePercent }, language),
  };
}
