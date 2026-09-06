/**
 * TransitCorridorController — POST /api/admin/map/corridor
 *
 * Responde a rota de transporte público PORTA A PORTA para UM par
 * prestador×paciente: tempo total, baldeações e o passo a passo. Nenhum
 * cálculo aqui: o controller valida, delega e registra (regra da casa —
 * controller não tem lógica de negócio).
 *
 * ⚖️ A chamada externa que isto dispara está contra o parecer do `lex` de
 * 05/09, por decisão do Gabriel — ver `GoogleTransitDirections` e
 * `.claude/docs/autorizacao-google-directions.md`.
 *
 * É POST com corpo, e não GET, pelo mesmo motivo dos dois mapas: id de pessoa
 * numa URL vai para o log de acesso do Cloud Run por 30 dias.
 *
 * 🔒 UM PAR POR CHAMADA, de propósito. Aceitar lista transformaria a rota num
 * gerador de matriz de distâncias — a mesma enumeração que fez o teto do mapa
 * cair de 5.000 para 500 pontos. O schema é `.strict()`: chave a mais é 400.
 *
 * 🔒 A TRILHA LEVA IDS E NUNCA GEOGRAFIA. A regra do parecer é
 * "mapa = geohash sem id; rota = id sem geohash": lá o geocódigo só é
 * admissível porque não há identificador na mesma linha; aqui o identificador é
 * o ponto da trilha, então nenhum geocódigo pode entrar junto. E o `resultado` é
 * ENUM, nunca minutos, metros ou nº de baldeações: `(prestador, paciente, 37min)`
 * repetido sobre N prestadores é TRILATERAÇÃO — sem uma única coordenada no log,
 * N linhas devolvem o domicílio do paciente com precisão crescente.
 */
import { Request, Response } from 'express';
import { z } from 'zod';
import { logger, reportError } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { GetTransitCorridorUseCase } from '../../application/GetTransitCorridorUseCase';

const uuid = z.string().uuid();

const CorridorBodySchema = z.object({
  country: z.enum(['AR', 'BR']),
  workerId: uuid,
  patientAddressId: uuid,
}).strict();

export class TransitCorridorController {
  private readonly useCase = new GetTransitCorridorUseCase(DatabaseConnection.getInstance().getPool());

  /** POST /api/admin/map/corridor */
  async getCorridor(req: Request, res: Response): Promise<void> {
    const parsed = CorridorBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid corridor request', details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;

    try {
      const result = await this.useCase.execute(body);

      logger.info({
        msg: 'map.corridor.read',
        uid: req.user?.uid ?? null,
        country: body.country,
        action: 'transit_corridor',
        workerId: body.workerId,
        patientAddressId: body.patientAddressId,
        // ENUM, e só. Nem duração, nem distância, nem parada, nem geohash.
        outcome: result.outcome,
      });

      res.status(200).json({
        success: true,
        data: {
          outcome: result.outcome,
          straightLineMeters: result.straightLineMeters,
          routes: result.routes,
        },
      });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'TransitCorridorController:getCorridor' });
      res.status(500).json({ success: false, error: 'Failed to compute transit corridor' });
    }
  }
}
