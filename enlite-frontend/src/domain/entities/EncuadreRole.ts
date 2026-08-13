/**
 * Papel do encuadre selecionado (espelha encuadres.role no backend, migration 142).
 * TITULAR = titular do caso; RAPID_RESPONSE = substituto/backup.
 * Base da feature "Equipe Armada = quadro completo".
 */
export type EncuadreRole = 'TITULAR' | 'RAPID_RESPONSE';

export const ENCUADRE_ROLES: readonly EncuadreRole[] = ['TITULAR', 'RAPID_RESPONSE'];
