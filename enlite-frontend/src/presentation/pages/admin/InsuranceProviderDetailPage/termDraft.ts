/**
 * Rascunho de um termo de valor (valor-hora + imposto + vigência) e a sua validação — spec 058 §4.3.
 *
 * REGRA DURA: o imposto NASCE VAZIO e é obrigatório. `0` significa "isento" e só existe se a pessoa DIGITAR; um `0` pré-preenchido
 * viraria "não informei" gravado como isento (o banco também não tem DEFAULT). O único "hoje" da tela é o `asOf` que a API devolve:
 * ele é o início sugerido e a data mínima; data anterior é aceita, com aviso (termo retroativo).
 */
import { useEffect, useState } from 'react';
import type { InsuranceTermBody } from '@domain/entities/InsuranceContract';
import { isDayBefore } from './calendar';

export interface TermDraft {
  hourlyRate: string;
  taxRatePercent: string;
  validFrom: string;
  validTo: string;
}

/** Chaves de erro = `admin.insuranceProviders.contracts.termForm.<chave>`. */
export type TermErrorKey = 'rateRequired' | 'taxRequired' | 'taxRange' | 'validFromRequired' | 'validToBeforeFrom';
export type TermErrors = Partial<Record<'hourlyRate' | 'taxRatePercent' | 'validFrom' | 'validTo', TermErrorKey>>;

/** O rascunho inicial: valor e imposto VAZIOS; início = `asOf` (ou vazio enquanto ele não chegou). */
export function emptyTermDraft(asOf: string | null): TermDraft {
  return { hourlyRate: '', taxRatePercent: '', validFrom: asOf ?? '', validTo: '' };
}

/** Número digitado, ou `null` se vazio/ilegível (`''` nunca vira `0`). */
function parseNumber(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function validateTermDraft(draft: TermDraft): { errors: TermErrors; body: InsuranceTermBody | null } {
  const errors: TermErrors = {};
  const rate = parseNumber(draft.hourlyRate);
  const tax = parseNumber(draft.taxRatePercent);
  if (rate === null || rate <= 0) errors.hourlyRate = 'rateRequired';
  if (tax === null) errors.taxRatePercent = 'taxRequired';
  else if (tax < 0 || tax > 100) errors.taxRatePercent = 'taxRange';
  if (draft.validFrom === '') errors.validFrom = 'validFromRequired';
  if (draft.validTo !== '' && isDayBefore(draft.validTo, draft.validFrom)) errors.validTo = 'validToBeforeFrom';
  if (Object.keys(errors).length > 0 || rate === null || tax === null) return { errors, body: null };
  return {
    errors,
    body: {
      hourlyRate: rate,
      taxRatePercent: tax,
      validFrom: draft.validFrom,
      ...(draft.validTo !== '' ? { validTo: draft.validTo } : {}),
    },
  };
}

export interface TermDraftState {
  draft: TermDraft;
  errors: TermErrors;
  set: (field: keyof TermDraft, value: string) => void;
  /** Valida e devolve o corpo (ou `null` mostrando os erros). */
  submit: () => InsuranceTermBody | null;
}

export function useTermDraft(asOf: string | null): TermDraftState {
  const [draft, setDraft] = useState<TermDraft>(() => emptyTermDraft(asOf));
  const [errors, setErrors] = useState<TermErrors>({});

  // O `asOf` pode chegar depois (contrato novo: só se sabe o "hoje" depois de escolher o país). Só preenche o início se a pessoa ainda não digitou.
  useEffect(() => {
    if (asOf) setDraft((d) => (d.validFrom === '' ? { ...d, validFrom: asOf } : d));
  }, [asOf]);

  return {
    draft,
    errors,
    set: (field, value) => setDraft((d) => ({ ...d, [field]: value })),
    submit: () => {
      const result = validateTermDraft(draft);
      setErrors(result.errors);
      return result.body;
    },
  };
}
