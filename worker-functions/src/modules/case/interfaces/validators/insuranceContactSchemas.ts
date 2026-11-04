import { z } from 'zod';
import { DOCUMENT_TYPES } from '../../domain/enums/DocumentType';

/** Código de erro do par tipo+número do documento (spec 058 §3.2, cartão Empregados). */
export const DOCUMENT_PAIR_INCOMPLETE = 'DOCUMENT_PAIR_INCOMPLETE';

const nonBlank = (max: number) => z.string().trim().min(1).max(max);

/**
 * Par `documentType` + `documentNumber`: se UMA das chaves vem, a outra tem de vir, e as duas precisam ser valores ou as duas `null`.
 * Ausentes as duas = não toca (PATCH) / sem documento (POST). É a MESMA regra do CHECK `insurance_provider_contacts_document_pair_chk`,
 * recusada aqui antes do banco com um código legível.
 */
export function documentPairIsComplete(v: { documentType?: unknown; documentNumber?: unknown }): boolean {
  const hasType = 'documentType' in v && v.documentType !== undefined;
  const hasNumber = 'documentNumber' in v && v.documentNumber !== undefined;
  if (!hasType && !hasNumber) return true;
  if (hasType !== hasNumber) return false;
  return (v.documentType === null) === (v.documentNumber === null);
}

const pairMessage = { message: DOCUMENT_PAIR_INCOMPLETE, path: ['documentType'] };

const documentFields = {
  documentType: z.enum(DOCUMENT_TYPES as unknown as [string, ...string[]]).nullable().optional(),
  documentNumber: nonBlank(60).nullable().optional(),
};

/** POST …/contacts — `fullName`, `roleTitle`, `phone` obrigatórios; `email` e o par do documento opcionais. */
export const createInsuranceContactSchema = z
  .object({
    fullName: nonBlank(200),
    roleTitle: nonBlank(120),
    phone: nonBlank(40),
    email: z.string().trim().email().max(254).nullable().optional(),
    ...documentFields,
  })
  .strict()
  .refine(documentPairIsComplete, pairMessage);

/**
 * PATCH …/contacts/:contactId — ausente = não toca; `null` limpa só `email` e o PAR do documento (os dois juntos); `''` = erro.
 * `fullName`, `roleTitle` e `phone` são NOT NULL: `null` = erro.
 */
export const patchInsuranceContactSchema = z
  .object({
    fullName: nonBlank(200).optional(),
    roleTitle: nonBlank(120).optional(),
    phone: nonBlank(40).optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    ...documentFields,
  })
  .strict()
  .refine(documentPairIsComplete, pairMessage);

export const contactParamsSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(64),
  contactId: z.string().uuid(),
});
