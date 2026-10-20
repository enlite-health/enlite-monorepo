/**
 * Apoio dos testes do cadastro da obra social (spec 058 A2): `t` que resolve contra o pt-BR.json REAL (chave errada vira a própria
 * chave e o teste quebra), erro no formato do `InsuranceApiError`, contas com/sem célula e fixtures do fio.
 */
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import type { InsuranceContractItem } from '@domain/entities/InsuranceContract';
import type { InsuranceProviderContact, InsuranceProviderDetail } from '@domain/entities/InsuranceProviderDetail';

const translations = ptBR as Record<string, unknown>;

export function t(key: string, opts?: Record<string, unknown>): string {
  let current: unknown = translations;
  for (const part of key.split('.')) current = (current as Record<string, unknown> | undefined)?.[part];
  if (typeof current !== 'string') return opts && 'defaultValue' in opts ? String(opts.defaultValue) : key;
  return current.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(opts?.[k] ?? ''));
}

export const i18nMock = { useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) };

/** Um erro como o que o `AdminInsuranceApiService` lança (`InsuranceApiError`). */
export function apiError(status: number, code?: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(code ?? `HTTP ${status}`), { status, code, details });
}

/** Liga o engine de permissões com exatamente estas células. */
export function comCelulas(permissions: string[]): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
  });
}

/** Engine desligado (sem contrato): tudo liberado, como na stage. */
export function semEnforcement(): void {
  useAdminAuthStore.setState({ authzStatus: 'idle', authz: null });
}

export const provider = (over: Partial<InsuranceProviderDetail> = {}): InsuranceProviderDetail => ({
  code: 'OSDE',
  name: 'OSDE',
  payerKind: null,
  active: true,
  legalName: null,
  taxId: null,
  address: null,
  managementChatId: null,
  sortOrder: 1,
  ...over,
});

export const contact = (over: Partial<InsuranceProviderContact> = {}): InsuranceProviderContact => ({
  id: 'c1',
  fullName: 'Pessoa Teste',
  roleTitle: 'Gerente operacional',
  phone: '+54 11 5555-0000',
  email: 'pessoa@exemplo.test',
  document: { type: 'CPF', number: '000.000.000-00' },
  retired: false,
  redacted: false,
  ...over,
});

export const okTerm = (over: Record<string, unknown> = {}) => ({
  state: 'OK' as const,
  termId: 't1',
  validFrom: '2026-01-01',
  validTo: null,
  taxRatePercent: 21,
  price: { state: 'OK' as const, hourlyRate: 1500, currency: 'ARS' as const },
  ...over,
});

export const contractItem = (over: Partial<InsuranceContractItem> = {}): InsuranceContractItem => ({
  id: 'k1',
  name: 'Contrato Buenos Aires',
  country: 'AR',
  scopeDescription: 'Região metropolitana',
  asOf: '2026-10-19',
  currentTerm: okTerm(),
  futureTerms: [],
  ...over,
});
