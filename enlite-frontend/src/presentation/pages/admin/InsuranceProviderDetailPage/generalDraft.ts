/**
 * Rascunho do cartão Dados gerais e o corpo do PATCH — spec 058 §4.2 (ausente = não toca; `null` limpa só os anuláveis; `''` é 422).
 */
import type { PayerKind } from '@domain/entities/InsuranceContract';
import type { InsuranceProviderDetail, PatchInsuranceProviderBody } from '@domain/entities/InsuranceProviderDetail';

export type OptionalText = 'legalName' | 'taxId' | 'address' | 'managementChatId';
export const OPTIONAL_FIELDS: readonly OptionalText[] = ['legalName', 'taxId', 'address', 'managementChatId'];

export interface Draft {
  name: string;
  legalName: string;
  taxId: string;
  address: string;
  managementChatId: string;
  payerKind: PayerKind | '';
  active: boolean;
}

export const toDraft = (p: InsuranceProviderDetail): Draft => ({
  name: p.name,
  legalName: p.legalName ?? '',
  taxId: p.taxId ?? '',
  address: p.address ?? '',
  managementChatId: p.managementChatId ?? '',
  payerKind: p.payerKind ?? '',
  active: p.active,
});

/** Só o que mudou. Opcional apagado → `null`; opcional que continua vazio → fora do corpo. */
export function buildGeneralPatch(p: InsuranceProviderDetail, d: Draft): PatchInsuranceProviderBody {
  const body: PatchInsuranceProviderBody = {};
  if (d.name.trim() !== p.name) body.name = d.name.trim();
  for (const f of OPTIONAL_FIELDS) {
    const next = d[f].trim();
    const prev = p[f] ?? '';
    if (next === prev) continue;
    body[f] = next === '' ? null : next;
  }
  if (d.payerKind !== '' && d.payerKind !== p.payerKind) body.payerKind = d.payerKind;
  if (d.active !== p.active) body.active = d.active;
  return body;
}
