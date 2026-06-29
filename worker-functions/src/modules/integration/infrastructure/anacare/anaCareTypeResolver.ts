/**
 * anaCareTypeResolver — resolve tipo_enfermera e tipo_contratacion via catálogo AnaCare.
 *
 * Cache em memória por execução (catálogos não mudam durante o backfill).
 * Se não conseguir resolver, OMITE o campo e loga — NÃO inventa ID.
 *
 * Mapa configurável:
 *   profession (AT/CUIDADOR) → nome do tipo_enfermera
 *   employmentType           → nome do tipo_contratacion
 *
 * Os nomes no mapa DEVEM ser iguais (após trim) ao campo `name` do catálogo.
 * Ref: docs/features/anacare/agencies-integration-api-v2.md §4.1
 */

import type { IAnaCareApiClient, AnaCareNurseType, AnaCareHiringType } from '../../domain/IAnaCareApiClient';
import { logger } from '@shared/logging';

const TAG = '[anaCareTypeResolver]';

// ─── Mapas de vocabulário Enlite → nome no catálogo AnaCare ────────────────────
// Valores CONFIRMADOS pelo catálogo real da agência Enlite no AnaCare
// (admin/agencies/nurse-type/, verificado 2026-06-23):
//   Acompañante Terapéutico · Cuidador (a) · Estudiante Avanzado Psicología · Psicólogo (a)
// Só mapeamos AT e CUIDADOR (decisão do user); os demais ficam sem espelho.
// O match é por `name` (case-insensitive, trim) — ver §4.1 da doc da API.

const PROFESSION_TO_NURSE_TYPE_NAME: Record<string, string> = {
  AT: 'Acompañante Terapéutico',
  CUIDADOR: 'Cuidador (a)',
};

const EMPLOYMENT_TYPE_TO_HIRING_TYPE_NAME: Record<string, string> = {
  // Valores livres do campo occupation/employmentType → tipo_contratacion (a confirmar)
  MEI: 'Independiente',
  FREELANCER: 'Independiente',
};

// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedTypes {
  tipo_enfermera?: number | string;
  tipo_contratacion?: number | string;
}

export class AnaCareTypeResolver {
  private readonly client: IAnaCareApiClient;

  // Cache por instância (vida útil = uma execução do backfill)
  private nurseTypesCache: AnaCareNurseType[] | null = null;
  private hiringTypesCache: AnaCareHiringType[] | null = null;

  constructor(client: IAnaCareApiClient) {
    this.client = client;
  }

  // ── Cache loaders ────────────────────────────────────────────────

  private async getNurseTypes(): Promise<AnaCareNurseType[]> {
    if (this.nurseTypesCache) return this.nurseTypesCache;
    const resp = await this.client.listNurseTypes();
    this.nurseTypesCache = resp.results;
    logger.info({ msg: `${TAG} loaded ${resp.results.length} nurse types from AnaCare` });
    return this.nurseTypesCache;
  }

  private async getHiringTypes(): Promise<AnaCareHiringType[]> {
    if (this.hiringTypesCache) return this.hiringTypesCache;
    const resp = await this.client.listHiringTypes();
    this.hiringTypesCache = resp.results;
    logger.info({ msg: `${TAG} loaded ${resp.results.length} hiring types from AnaCare` });
    return this.hiringTypesCache;
  }

  // ── Resolvers ────────────────────────────────────────────────────

  /**
   * Resolve tipo_enfermera a partir da profissão do worker.
   * Retorna o ID numérico do catálogo se encontrado, undefined caso contrário.
   * NÃO inventa IDs — omite silenciosamente com log.
   */
  async resolveNurseType(profession: string | null | undefined): Promise<number | undefined> {
    if (!profession) return undefined;

    const targetName = PROFESSION_TO_NURSE_TYPE_NAME[profession.toUpperCase()];
    if (!targetName) {
      logger.info({
        msg: `${TAG} resolveNurseType: no mapping for profession`,
        profession,
      });
      return undefined;
    }

    try {
      const types = await this.getNurseTypes();
      const found = types.find(
        (t) => t.name.trim().toLowerCase() === targetName.toLowerCase(),
      );
      if (!found) {
        logger.warn({
          msg: `${TAG} resolveNurseType: '${targetName}' not found in AnaCare catalog`,
          profession,
          availableNames: types.map((t) => t.name),
        });
        return undefined;
      }
      return found.id;
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn({ msg: `${TAG} resolveNurseType: failed to fetch catalog`, error: e.message });
      return undefined;
    }
  }

  /**
   * Resolve tipo_contratacion a partir do employmentType do worker.
   * Retorna o ID numérico do catálogo se encontrado, undefined caso contrário.
   */
  async resolveHiringType(employmentType: string | null | undefined): Promise<number | undefined> {
    if (!employmentType) return undefined;

    const targetName = EMPLOYMENT_TYPE_TO_HIRING_TYPE_NAME[employmentType.toUpperCase()];
    if (!targetName) {
      logger.info({
        msg: `${TAG} resolveHiringType: no mapping for employmentType`,
        employmentType,
      });
      return undefined;
    }

    try {
      const types = await this.getHiringTypes();
      const found = types.find(
        (t) => t.name.trim().toLowerCase() === targetName.toLowerCase(),
      );
      if (!found) {
        logger.warn({
          msg: `${TAG} resolveHiringType: '${targetName}' not found in AnaCare catalog`,
          employmentType,
          availableNames: types.map((t) => t.name),
        });
        return undefined;
      }
      return found.id;
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      logger.warn({ msg: `${TAG} resolveHiringType: failed to fetch catalog`, error: e.message });
      return undefined;
    }
  }

  /** Resolve ambos os tipos de uma vez — campos indefinidos são omitidos do payload */
  async resolve(profession: string | null | undefined, employmentType: string | null | undefined): Promise<ResolvedTypes> {
    const [tipo_enfermera, tipo_contratacion] = await Promise.all([
      this.resolveNurseType(profession),
      this.resolveHiringType(employmentType),
    ]);

    const result: ResolvedTypes = {};
    if (tipo_enfermera !== undefined) result.tipo_enfermera = tipo_enfermera;
    if (tipo_contratacion !== undefined) result.tipo_contratacion = tipo_contratacion;
    return result;
  }

  /** Expõe os mapas para testes e documentação */
  static getProfessionMap(): Record<string, string> {
    return { ...PROFESSION_TO_NURSE_TYPE_NAME };
  }

  static getEmploymentTypeMap(): Record<string, string> {
    return { ...EMPLOYMENT_TYPE_TO_HIRING_TYPE_NAME };
  }
}
