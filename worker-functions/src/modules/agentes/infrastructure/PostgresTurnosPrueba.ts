import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { staffActor } from '@shared/audit/actorSource';
import type { TurnosPruebaPort } from '../domain/TriagePruebaPort';

/** O "dia" da pessoa é o de Buenos Aires (o mesmo fuso das semanas de `agentes.*`). */
const DIA_AR = `(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date`;

/**
 * Contador `agentes.luz_prueba_turnos (uid, dia, turnos)`: 1 statement atômico (UPSERT com o teto no WHERE do DO UPDATE),
 * então duas requisições simultâneas da mesma pessoa não passam do limite. Só uid/dia/contagem: nenhum texto de conversa.
 */
export class PostgresTurnosPrueba implements TurnosPruebaPort {
  constructor(private readonly pool: Pool) {}

  async consumir(uid: string, limite: number): Promise<{ permitido: boolean; turnos: number }> {
    return withActorContext(
      this.pool,
      async (c) => {
        const r = await c.query<{ turnos: number }>(
          `INSERT INTO agentes.luz_prueba_turnos AS t (uid, dia, turnos)
           SELECT $1::text, ${DIA_AR}, 1 WHERE $2::int >= 1
           ON CONFLICT (uid, dia) DO UPDATE SET turnos = t.turnos + 1 WHERE t.turnos < $2::int
           RETURNING turnos`,
          [uid, limite],
        );
        if (r.rows.length > 0) return { permitido: true, turnos: r.rows[0].turnos };
        return { permitido: false, turnos: limite };
      },
      staffActor(uid),
    );
  }

  async devolver(uid: string): Promise<void> {
    await withActorContext(
      this.pool,
      async (c) => {
        await c.query(
          `UPDATE agentes.luz_prueba_turnos SET turnos = turnos - 1 WHERE uid = $1 AND dia = ${DIA_AR} AND turnos > 0`,
          [uid],
        );
      },
      staffActor(uid),
    );
  }
}
