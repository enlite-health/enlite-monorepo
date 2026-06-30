/**
 * anaCareMapper — converte WorkerMirrorRecord para payload da API AnaCare v2.
 *
 * ATENÇÃO — INVERSÃO DE GÊNERO (documentada na API):
 *   "M" = femenino (FEMALE)  ← INVERTIDO
 *   "H" = masculino (MALE)   ← INVERTIDO
 *
 * Ref: docs/features/anacare/agencies-integration-api-v2.md §4
 */

import type { WorkerMirrorRecord } from '../../domain/WorkerMirrorRecord';
import type { AnaCareNursePayload } from '../../domain/IAnaCareApiClient';
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';

/**
 * Converte sexo canônico UPPERCASE EN para o código de gênero da API AnaCare.
 * ATENÇÃO: a API AnaCare usa "M" para femenino e "H" para masculino (invertido).
 */
export function mapSexToAnaCareGenero(
  sex: 'MALE' | 'FEMALE' | null | undefined,
): 'M' | 'H' | null {
  // Normaliza caso venha string raw
  const canonical = typeof sex === 'string'
    ? normalizeSexValue(sex)
    : sex ?? null;

  if (canonical === 'FEMALE') return 'M'; // femenino → "M"
  if (canonical === 'MALE') return 'H';   // masculino → "H"
  return null;
}

/**
 * Converte data de qualquer formato para YYYY-MM-DD.
 * Aceita Date, string ISO, ou null/undefined.
 */
export function formatDateYMD(value: string | Date | null | undefined): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return undefined;
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Retorna undefined se a string for vazia/null — garante que campos vazios sejam OMITIDOS */
function nonEmpty(val: string | null | undefined): string | undefined {
  const s = val?.trim();
  return s ? s : undefined;
}

/**
 * Mapeia WorkerMirrorRecord → AnaCareNursePayload (somente criação/alta completa).
 *
 * Campos obrigatórios: nombre, apellidos, genero, email.
 * Campos opcionais são omitidos quando null/vazio (não enviar string vazia para a API).
 *
 * Throws se nombre, apellidos, genero ou email estiverem ausentes.
 */
export function mapWorkerToAnaCarePayload(
  record: WorkerMirrorRecord,
  overrides?: {
    tipo_enfermera?: number | string;
    tipo_contratacion?: number | string;
  },
): AnaCareNursePayload {
  const nombre = nonEmpty(record.firstName);
  const apellidos = nonEmpty(record.lastName);
  const genero = mapSexToAnaCareGenero(record.sex);

  if (!nombre) throw new Error('mapWorkerToAnaCarePayload: firstName is required');
  if (!apellidos) throw new Error('mapWorkerToAnaCarePayload: lastName is required');
  if (!genero) throw new Error('mapWorkerToAnaCarePayload: sex is required and must be MALE or FEMALE');
  if (!record.email) throw new Error('mapWorkerToAnaCarePayload: email is required');

  const payload: AnaCareNursePayload = {
    nombre,
    apellidos,
    genero,
    email: record.email.toLowerCase().trim(),
  };

  // Telefone — omitir se vazio (deve ser único se enviado)
  const telefono = nonEmpty(record.phone);
  if (telefono) payload.telefono = telefono;

  // Endereço da área de atuação (worker_service_areas)
  const calle = nonEmpty(record.address.line);
  if (calle) payload.calle = calle;
  const estado = nonEmpty(record.address.state);
  if (estado) payload.estado = estado;
  const ciudad = nonEmpty(record.address.city);
  if (ciudad) payload.ciudad = ciudad;
  const colonia = nonEmpty(record.address.neighborhood);
  if (colonia) payload.colonia = colonia;
  const codigoPostal = nonEmpty(record.address.postalCode);
  if (codigoPostal) payload.codigo_postal = codigoPostal;

  // Data de nascimento — YYYY-MM-DD
  const fechaNacimiento = formatDateYMD(record.birthDate ?? null);
  if (fechaNacimiento) payload.fecha_nacimiento = fechaNacimiento;

  // cedula_ciudadania = documentNumber (CURP/DNI/CPF)
  const cedula = nonEmpty(record.documentNumber);
  if (cedula) payload.cedula_ciudadania = cedula;

  // Tipos opcionais (resolvidos pelo anaCareTypeResolver)
  if (overrides?.tipo_enfermera !== undefined) {
    payload.tipo_enfermera = overrides.tipo_enfermera;
  }
  if (overrides?.tipo_contratacion !== undefined) {
    payload.tipo_contratacion = overrides.tipo_contratacion;
  }

  return payload;
}
