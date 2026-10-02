/**
 * Kit dos testes da aba "Documentos" (spec 031): `t` real (es.json — o texto es-AR é o contrato),
 * com interpolação `{{x}}`; documento sintético (nome inventado, nunca dado real); e o estado de
 * permissão do store. Nenhum teste aqui usa texto clínico ou nome de pessoa real.
 */
import es from '@infrastructure/i18n/locales/es.json';
import type { PatientDocument } from '@infrastructure/http/AdminPatientDocumentsApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

export function tEs(key: string, opts?: unknown): string {
  let cur: unknown = es;
  for (const part of key.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[part];
  if (typeof cur !== 'string') return key;
  const vars = typeof opts === 'object' && opts !== null ? (opts as Record<string, string>) : {};
  return cur.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');
}

export const i18nMock = { useTranslation: () => ({ t: tEs, i18n: { language: 'es' } }) };

export function syntheticDoc(overrides: Partial<PatientDocument> = {}): PatientDocument {
  return {
    id: 'doc-1',
    origin: 'tab',
    label: 'Documento de prueba',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    createdAt: '2026-10-01T12:30:00.000Z',
    createdByUid: 'staff-1',
    createdByDisplayName: 'Operadora Prueba',
    labelUpdatedAt: null,
    ...overrides,
  };
}

/** `enforcement: 'on'` com exatamente estas células; `null` limpa o store (engine desligado = tudo liberado). */
export function setCells(permissions: string[] | null): void {
  if (permissions === null) {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    return;
  }
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {}, enforcement: 'on',
    } as AuthzContract,
  });
}
