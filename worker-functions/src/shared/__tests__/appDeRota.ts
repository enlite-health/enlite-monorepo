/**
 * Servidor Express reusado por suíte de teste de rota — o conserto de uma fonte
 * MEDIDA de falso positivo.
 *
 * ⚠️ O problema, medido: suítes de família montavam um app NOVO dentro de cada
 * caso do `it.each`, e o `request(app)` do supertest sobe um servidor efêmero
 * **por request**. Uma suíte com ~60 casos criava ~60 apps e ~60 servidores em
 * sequência, cada um num socket novo. Rodando `adminWorkerRoutes.test.ts`
 * SOZINHA, 15 vezes: **2 falhas**, sempre num caso diferente, com dois sintomas:
 *
 *   · `400 Bad Request` — o `clientError` do servidor HTTP do Node, resposta a
 *     requisição malformada no socket;
 *   · `200` com corpo vazio (`res.body.m === undefined`) — resposta truncada.
 *
 * Nenhum dos dois vem do código sob teste. É corrida de socket do HARNESS — e
 * era a maior fonte de vermelho não-reproduzível: fez o `pre-push` abortar duas
 * vezes e obrigou a rodar a suíte 2-3× em toda entrega.
 *
 * ⚠️ Memoizar só o APP não bastou: medido, caiu de 2/15 para 1/15, porque o
 * servidor efêmero continuava por request. Reusar o SERVIDOR é a outra metade.
 *
 * O cache é de módulo, e o jest reseta o registro de módulos por arquivo — não
 * há vazamento entre suítes. Dentro do arquivo, `chave` diferente = servidor
 * diferente, para o caso que precisa de app realmente novo.
 */

import express from 'express';
import type { Server } from 'http';

const servidores = new Map<string, Server>();

// Fecha tudo ao fim do arquivo. Registrado no import (fase de coleta do jest),
// uma vez por arquivo de teste — sem isso o processo fica com handle aberto e o
// jest reclama de "open handles" ou pendura.
afterAll(async () => {
  await Promise.all(
    [...servidores.values()].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
  servidores.clear();
});

/** O servidor (já escutando) da suíte. Passe-o direto para `request(...)`. */
export function appDeRota(
  chave: string,
  prefixo: string,
  montar: () => express.Router,
  antes?: (app: express.Express) => void,
): Server {
  const existente = servidores.get(chave);
  if (existente) return existente;

  const app = express();
  antes?.(app);
  app.use(prefixo, montar());
  const servidor = app.listen(0);
  servidores.set(chave, servidor);
  return servidor;
}
