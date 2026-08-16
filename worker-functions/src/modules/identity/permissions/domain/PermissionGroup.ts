/**
 * src/modules/identity/permissions/domain/PermissionGroup.ts
 *
 * O GRUPO é a única fonte de acesso do staff (D114): um conjunto nomeado de
 * células (`recurso:ação`) MAIS um conjunto de países concedidos. Os dois eixos
 * vivem no mesmo grupo — não existe grupo "só de país" (spec permission-groups).
 *
 * As invariantes daqui são as baratas e determinísticas (nome, grupo de
 * sistema, motivo). As que dependem de estado concorrente — anti-lockout,
 * unicidade de nome, célula fora do catálogo — são do BANCO (mig 279), que as
 * checa dentro da transação com lock. Repetir aquelas aqui daria falsa
 * segurança: entre a leitura e a escrita o mundo muda.
 */

import type { CountryCode } from '@shared/domain/countryCodes';
import { isCountryCode } from '@shared/domain/countryCodes';
import { PermissionError } from './PermissionError';

export interface PermissionGroup {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  /** Semeado pela mig 206: não renomeia, não arquiva (spec). */
  isSystem: boolean;
  archivedAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

/** Grupo com os dois eixos resolvidos — o que a tela de definição mostra. */
export interface PermissionGroupDetail extends PermissionGroup {
  /** Chaves `recurso:ação` do grupo. */
  cells: string[];
  /** Países concedidos e vivos. */
  countries: CountryCode[];
  /** Quantos membros vivos — a tela avisa antes de arquivar. */
  memberCount: number;
}

export const GROUP_NAME_MAX = 255;
export const REASON_MAX = 500;

export function assertValidGroupName(name: string): string {
  const trimmed = name?.trim() ?? '';
  if (trimmed.length < 3) {
    throw new PermissionError('invalid_input', 'Nome do grupo precisa de ao menos 3 caracteres');
  }
  if (trimmed.length > GROUP_NAME_MAX) {
    throw new PermissionError('invalid_input', `Nome do grupo excede ${GROUP_NAME_MAX} caracteres`);
  }
  return trimmed;
}

/** Grupo de sistema não renomeia nem arquiva — a mig 279 recusa também. */
export function assertNotSystemGroup(group: Pick<PermissionGroup, 'isSystem'>, operation: string): void {
  if (group.isSystem) {
    throw new PermissionError('system_group', `Grupo de sistema: ${operation} não é permitido`);
  }
}

export function isLiveGroup(group: Pick<PermissionGroup, 'archivedAt'>): boolean {
  return group.archivedAt === null;
}

export function assertSupportedCountry(country: unknown): CountryCode {
  if (!isCountryCode(country)) {
    throw new PermissionError('invalid_country', `País não suportado: ${String(country)}`);
  }
  return country;
}

/**
 * E-mail ou sequência longa de dígitos (DNI, CUIL, CPF, telefone) em campo de
 * texto livre de trilha administrativa.
 *
 * (lex C10) O `reason` de uma concessão de país / override de feature fica numa
 * tabela de retenção longa (6 anos, mig 280) e vai para a tela de auditoria —
 * é trilha de DECISÃO ADMINISTRATIVA, não lugar de dado de titular. O painel
 * avisa antes de enviar; aqui a regra é dura porque o aviso da UI é
 * contornável e o dado, uma vez gravado, exige expurgo.
 */
export function containsLikelyPersonalData(text: string): boolean {
  return /[\w.+-]+@[\w-]+\.[\w.]+/.test(text) || /\d[\d.\-/\s]{7,}/.test(text);
}

/** Motivo obrigatório e sem dado de pessoa. Devolve o texto normalizado. */
export function assertValidReason(reason: unknown): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (trimmed === '') {
    throw new PermissionError('reason_required', 'Esta operação exige motivo');
  }
  if (trimmed.length > REASON_MAX) {
    throw new PermissionError('invalid_input', `Motivo excede ${REASON_MAX} caracteres`);
  }
  if (containsLikelyPersonalData(trimmed)) {
    throw new PermissionError(
      'invalid_input',
      'Motivo não pode conter dado de pessoa (e-mail, documento, telefone) — descreva a decisão',
    );
  }
  return trimmed;
}
