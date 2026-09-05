/**
 * transitCorridorRoutes — POST /api/admin/map/corridor
 *
 * O corredor logístico do /admin/mapa: um par prestador×paciente por chamada.
 *
 * 🔒 RATE LIMIT POR STAFF, não por IP. O Cloud Run fica atrás de balanceador, e
 * ali todos os requests chegam com o mesmo IP — limite por IP seria global e
 * derrubaria a recrutadora seguinte, não quem enumerou. O teto é generoso para
 * o uso real (clicar pinos de uma lista de 5 km) e apertado para varredura: a
 * rota devolve relação entre DUAS pessoas, e sem limite ela é um gerador de
 * matriz de distâncias — a mesma enumeração que fez o teto do mapa cair de
 * 5.000 para 500 pontos.
 */
import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { TransitCorridorController } from '../controllers/TransitCorridorController';

/** 60/min por staff: ~1 clique por segundo sustentado, muito acima do uso humano. */
export const corridorRateLimit = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
  keyGenerator: (req: Request) => {
    const uid = req.user?.uid;
    if (uid) return `staff:${uid}`;
    // `ipKeyGenerator` e não `req.ip` cru: em IPv6 cada cliente recebe um /128
    // dentro de um bloco imenso, então chave por endereço exato deixa a mesma
    // pessoa trocar de IP à vontade e furar o limite. O helper normaliza para o
    // prefixo. A própria lib acusa isto em tempo de boot — foi assim que apareceu.
    return `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
});

export function createTransitCorridorRoutes(
  staffOnly: (req: Request, res: Response, next: () => void) => void,
): Router {
  const router = Router();
  const controller = new TransitCorridorController();
  router.post('/map/corridor', staffOnly, corridorRateLimit, (req: Request, res: Response) =>
    controller.getCorridor(req, res));
  return router;
}
