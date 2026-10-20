/**
 * Rascunho de um empregado (contato) da obra social e o corpo do POST/PATCH — spec 058 §4.2.
 * E-mail e documento são OPCIONAIS; o documento é um PAR (tipo + número juntos, ou os dois vazios — `DOCUMENT_PAIR_INCOMPLETE`).
 * O tipo vem de `WORKER_DOCUMENT_TYPES` (mesmo vocabulário do documento do prestador; sem lista nova).
 */
import { WORKER_DOCUMENT_TYPES } from '@domain/entities/Worker';
import type { InsuranceContactBody, InsuranceProviderContact, PatchInsuranceContactBody } from '@domain/entities/InsuranceProviderDetail';

type DocType = (typeof WORKER_DOCUMENT_TYPES)[number];

export interface ContactDraft {
  fullName: string;
  roleTitle: string;
  phone: string;
  email: string;
  documentType: DocType | '';
  documentNumber: string;
}

export const EMPTY_CONTACT_DRAFT: ContactDraft = { fullName: '', roleTitle: '', phone: '', email: '', documentType: '', documentNumber: '' };

export const contactToDraft = (c: InsuranceProviderContact): ContactDraft => ({
  fullName: c.fullName,
  roleTitle: c.roleTitle,
  phone: c.phone ?? '',
  email: c.email ?? '',
  documentType: c.document?.type ?? '',
  documentNumber: c.document?.number ?? '',
});

export type ContactDraftError = 'required' | 'documentPairIncomplete' | null;

export function validateContactDraft(d: ContactDraft): ContactDraftError {
  if (d.fullName.trim() === '' || d.roleTitle.trim() === '' || d.phone.trim() === '') return 'required';
  const hasType = d.documentType !== '';
  const hasNumber = d.documentNumber.trim() !== '';
  return hasType !== hasNumber ? 'documentPairIncomplete' : null;
}

/** POST: opcional vazio fica FORA do corpo. */
export function contactCreateBody(d: ContactDraft): InsuranceContactBody {
  return {
    fullName: d.fullName.trim(),
    roleTitle: d.roleTitle.trim(),
    phone: d.phone.trim(),
    ...(d.email.trim() !== '' ? { email: d.email.trim() } : {}),
    ...(d.documentType !== '' ? { documentType: d.documentType, documentNumber: d.documentNumber.trim() } : {}),
  };
}

/** PATCH: só o que mudou; e-mail apagado → `null`; documento apagado → `documentType:null` + `documentNumber:null` (o par limpa junto). */
export function contactPatchBody(prev: InsuranceProviderContact, d: ContactDraft): PatchInsuranceContactBody {
  const body: PatchInsuranceContactBody = {};
  if (d.fullName.trim() !== prev.fullName) body.fullName = d.fullName.trim();
  if (d.roleTitle.trim() !== prev.roleTitle) body.roleTitle = d.roleTitle.trim();
  if (d.phone.trim() !== (prev.phone ?? '')) body.phone = d.phone.trim();
  if (d.email.trim() !== (prev.email ?? '')) body.email = d.email.trim() === '' ? null : d.email.trim();
  const prevType = prev.document?.type ?? '';
  const prevNumber = prev.document?.number ?? '';
  if (d.documentType !== prevType || d.documentNumber.trim() !== prevNumber) {
    if (d.documentType === '') {
      body.documentType = null;
      body.documentNumber = null;
    } else {
      body.documentType = d.documentType;
      body.documentNumber = d.documentNumber.trim();
    }
  }
  return body;
}
