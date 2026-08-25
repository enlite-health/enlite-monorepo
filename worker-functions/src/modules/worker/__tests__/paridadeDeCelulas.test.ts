/**
 * Paridade das chaves de célula copiadas para o módulo `worker` (B5 do gate).
 *
 * `workerExportCells.ts` e `transicaoDeBaixa.ts` repetem chaves que o barrel
 * `@modules/identity/permissions` já exporta. A cópia é consciente e está
 * justificada em cada arquivo: os dois são puros (domínio e aplicação sem
 * estado) e o barrel arrasta `pg` junto com `createPermissionsModule` — a
 * importação meteria o driver de banco no grafo de quem não fala com banco.
 *
 * O que a cópia custaria sem esta guarda é o dano REAL: a chave canônica muda,
 * a projeção passa a autorizar por `worker_pii:read.v2` e o export continua
 * negando pela chave velha — dois lugares discordando, nada vermelho. Aqui o
 * teste é o único lugar que pode importar o barrel sem custo, porque teste não
 * é embarcado.
 *
 * Se este arquivo ficar vermelho, o conserto NÃO é ajustar a cópia: é entender
 * por que a chave canônica mudou e revisar quem mais a repete.
 */

import { CELL_WORKER_PII_READ as CANONICA_PII, CELL_WORKER_DISABLE as CANONICA_BAIXA } from '@modules/identity/permissions';
import { CELL_WORKER_PII_READ as COPIA_PII } from '../application/export/workerExportCells';
import { CELL_WORKER_DISABLE as COPIA_BAIXA } from '../domain/transicaoDeBaixa';

describe('as chaves copiadas batem com as do catálogo', () => {
  it('`worker_pii:read` — export × projeção', () => {
    expect(COPIA_PII).toBe(CANONICA_PII);
  });

  it('`worker:disable` — baixa × projeção', () => {
    expect(COPIA_BAIXA).toBe(CANONICA_BAIXA);
  });

  it('e as canônicas são as chaves que o catálogo de fato usa', () => {
    // Controle POSITIVO: sem isto, as duas constantes poderiam virar `''` das
    // duas pontas ao mesmo tempo e os casos acima continuariam verdes.
    expect(CANONICA_PII).toBe('worker_pii:read');
    expect(CANONICA_BAIXA).toBe('worker:disable');
  });
});
