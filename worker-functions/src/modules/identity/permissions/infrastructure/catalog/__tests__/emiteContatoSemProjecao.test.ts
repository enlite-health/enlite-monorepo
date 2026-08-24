/**
 * C4 — rota que emita contato de prestador sem passar pela projeção falha o CI.
 *
 * ⚠️ A prova de que esta régua está VIVA é o CONTROLE POSITIVO, e ele roda em
 * toda execução, não uma vez numa sabotagem minha: um alvo sintético plantado
 * TEM de ser acusado. Régua de controle não detecta instrumento morto — só a
 * positiva detecta (D154/D155/D160). Se alguém quebrar a regex, o alvo plantado
 * fica verde e este arquivo fica vermelho.
 */

import * as fs from 'fs';
import * as path from 'path';
import { analisar, COLUNAS_DE_PRESTADOR } from '../emiteContatoSemProjecao';

/** Sobe de `permissions/infrastructure/catalog/__tests__` até `src/`. */
const SRC = path.resolve(__dirname, '..', '..', '..', '..', '..', '..');

/**
 * DÍVIDA DECLARADA — a lista SÓ ENCOLHE.
 *
 * Não é allowlist de "pode vazar": é o inventário do que ainda não passou pela
 * projeção, e cada linha nomeia a condição do `lex` que a remove. O teste falha
 * nas DUAS direções: arquivo novo aqui reprova, e arquivo consertado que fique
 * na lista também — senão a lista vira lixo que ninguém poda.
 */
const DIVIDA_DECLARADA: ReadonlyArray<readonly [string, string]> = [
  [
    'src/modules/worker/interfaces/controllers/AdminWorkersController.ts',
    'Dossiê do prestador (nome, DNI, nascimento, endereço). É a superfície da C5 — ' +
    '`worker:export` com gate por coluna. Sai daqui quando a C5 fechar.',
  ],
  [
    'src/modules/matching/interfaces/controllers/RecruitmentAnalyticsController.ts',
    '`e.worker_raw_name` e `e.worker_raw_phone` em texto claro no relatório de encuadres ' +
    '(:147,:149). O diagnóstico do paciente já saiu daqui na C1; o contato do prestador não.',
  ],
  [
    'src/modules/matching/interfaces/controllers/RecruitmentController.ts',
    '`e.worker_raw_name`/`worker_raw_phone` no relatório de recrutamento (:286). Mesma classe.',
  ],
  [
    'src/modules/notification/interfaces/controllers/MessagingController.ts',
    '`whatsapp_phone_encrypted` descriptografado para ENVIAR mensagem — uso legítimo. ' +
    'Precisa de decisão própria: o telefone é insumo do envio, não conteúdo de resposta. ' +
    'Confirmar se algum `res.json` daqui devolve o número antes de tirar da lista.',
  ],
];

/** Anda no fonte e devolve os caminhos relativos que emitem PII sem projetar. */
function varrer(): { infratores: string[]; examinados: number } {
  const infratores: string[] = [];
  let examinados = 0;

  const anda = (dir: string): void => {
    for (const nome of fs.readdirSync(dir)) {
      const cheio = path.join(dir, nome);
      const st = fs.statSync(cheio);
      if (st.isDirectory()) {
        if (nome === 'node_modules' || nome === '__tests__') continue;
        anda(cheio);
        continue;
      }
      if (!nome.endsWith('.ts') || nome.endsWith('.d.ts')) continue;
      examinados++;
      const rel = path.relative(path.dirname(SRC), cheio);
      // A própria projeção cita as colunas e não é emissora.
      if (rel.includes('identity/permissions/')) continue;
      if (analisar(fs.readFileSync(cheio, 'utf8')).emiteContatoSemProjecao) {
        infratores.push(rel);
      }
    }
  };

  anda(SRC);
  return { infratores, examinados };
}

describe('C4 — contato de prestador não sai sem passar pela projeção', () => {
  it('a varredura olhou para o fonte de verdade — contagem zero é falha, não sucesso', () => {
    // Autocheque do caminho: já me pegou um off-by-one aqui. Sem ele, um `..`
    // a mais faria a varredura andar em diretório vazio e ficar verde por nada.
    expect(path.basename(SRC)).toBe('src');
    const { examinados } = varrer();
    // Se algum dia isto virar 0, a régua ficou verde por não ter olhado.
    expect(examinados).toBeGreaterThan(500);
  });

  it('nenhum arquivo NOVO emite contato sem projeção — e a dívida só encolhe', () => {
    const { infratores } = varrer();
    const declarados = DIVIDA_DECLARADA.map(([p]) => p);

    const novos = infratores.filter((f) => !declarados.includes(f));
    const jaConsertados = declarados.filter((f) => !infratores.includes(f));

    expect({ novos, jaConsertados }).toEqual({ novos: [], jaConsertados: [] });
  });

  // ── CONTROLE POSITIVO: o alvo plantado TEM de ser acusado ──────────────────

  it('CONTROLE POSITIVO — rota sintética que emite nome cifrado é ACUSADA', () => {
    const alvoPlantado = `
      export class RotaNovaController {
        async listar(req: Request, res: Response) {
          const r = await this.db.query('SELECT first_name_encrypted FROM workers');
          const nome = await this.kms.decrypt(r.rows[0].first_name_encrypted);
          res.status(200).json({ success: true, data: { nome } });
        }
      }
    `;
    expect(analisar(alvoPlantado).emiteContatoSemProjecao).toBe(true);
  });

  it('CONTROLE POSITIVO — o texto claro do import legado também é acusado', () => {
    const alvoPlantado = `
      const linhas = await db.query('SELECT worker_raw_name, worker_raw_phone FROM encuadres');
      res.json({ data: linhas.rows });
    `;
    expect(analisar(alvoPlantado).emiteContatoSemProjecao).toBe(true);
  });

  it('CONTROLE NEGATIVO — a mesma rota, passando pela projeção, é liberada', () => {
    const rotaCerta = `
      const r = await this.db.query('SELECT first_name_encrypted FROM workers');
      const visivel = await projectWorkerFields(cellsOfRequest(req), r.rows[0], kms);
      res.status(200).json({ success: true, data: visivel });
    `;
    expect(analisar(rotaCerta).emiteContatoSemProjecao).toBe(false);
  });

  it('quem cita a coluna mas NÃO responde HTTP não é alvo — repositório não emite', () => {
    const repositorio = `
      export class WorkerRepository {
        async buscar(id: string) {
          return this.db.query('SELECT first_name_encrypted FROM workers WHERE id = $1', [id]);
        }
      }
    `;
    const v = analisar(repositorio);
    expect(v.citaColuna).toBe(true);
    expect(v.emiteResposta).toBe(false);
    expect(v.emiteContatoSemProjecao).toBe(false);
  });

  it('quem responde HTTP mas não toca PII de prestador não é alvo', () => {
    const v = analisar(`res.json({ success: true, data: { total: 42 } });`);
    expect(v.citaColuna).toBe(false);
    expect(v.emiteResposta).toBe(true);
    expect(v.emiteContatoSemProjecao).toBe(false);
  });

  it('as 9 colunas da lista são todas detectadas — nenhuma entrou só de enfeite', () => {
    for (const coluna of COLUNAS_DE_PRESTADOR) {
      const v = analisar(`const x = row.${coluna}; res.json({ x });`);
      expect([coluna, v.emiteContatoSemProjecao]).toEqual([coluna, true]);
    }
  });
});
