/**
 * clickup-rotas-removidas-sentinela-de-texto.test.ts — TRAVA ANTI-VOLTA mais larga (gate
 * revisao-pr, 3ª rodada).
 *
 * `clickup-rotas-removidas-nao-voltam.test.ts` prova que `createWebhookRoutes`/
 * `createInternalRoutes` (os construtores de router) nunca reintroduzem as rotas — mas não pega
 * alguém que contorne os dois e registre a rota DIRETO em `startServer.ts` via
 * `app.post('/api/webhooks/clickup/patient', ...)`, sem passar pelos construtores nenhuma vez.
 *
 * Este teste varre TODO `.ts` de `src/` como TEXTO (sem executar nada) e reprova se qualquer
 * arquivo contiver `/clickup/patient`, `/webhooks/clickup/patient` ou `sync-clickup-patients`
 * FORA de comentário — não importa em qual arquivo, qual função, ou se passa por
 * createWebhookRoutes/createInternalRoutes ou não.
 *
 * Comentário HISTÓRICO que cita a rota removida (documentando a remoção, não reintroduzindo-a)
 * é esperado e IGNORADO de propósito — por isso o stripper de comentário roda ANTES da busca.
 * Medido no estado atual (11/09/2026): `webhooksTest.ts` cita `/clickup/patient` só em `//`
 * comentário explicando que a rota saiu — o stripper tira essas 2 linhas e o teste passa limpo.
 *
 * Provado por sabotagem (ver o commit desta mudança): `cp` de backup, reintroduzido
 * `app.post('/api/webhooks/clickup/patient', ...)` direto em `startServer.ts` (sem tocar
 * `webhookRoutes.ts`, exatamente o cenário que o outro teste anti-volta NÃO pega) → este teste
 * CAI; restaurado via `cp` → passa de novo.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC_ROOT = path.resolve(__dirname, '../../../src');

const PADROES_PROIBIDOS = [
  '/clickup/patient',
  '/webhooks/clickup/patient',
  'sync-clickup-patients',
] as const;

/** Tira comentário de bloco `/* ... *\/` e de linha `// ...` — NÃO é um parser TS completo (não
 *  entende string com `//` dentro, por exemplo), mas é o bastante para este sentinela: o
 *  objetivo é achar rota em CÓDIGO, e nenhum registro de rota real escreve `//` dentro do
 *  literal do path. */
function semComentarios(conteudo: string): string {
  const semBloco = conteudo.replace(/\/\*[\s\S]*?\*\//g, '');
  const semLinha = semBloco.replace(/\/\/.*$/gm, '');
  return semLinha;
}

function listarArquivosTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listarArquivosTs(full));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('sentinela de texto — nenhuma rota do ClickUp removida pode voltar em src/, por QUALQUER caminho', () => {
  const arquivos = listarArquivosTs(SRC_ROOT);

  it('CONTROLE — a varredura encontrou arquivos de verdade (o sentinela não está cego)', () => {
    // Sem isto, um SRC_ROOT errado (path quebrado) faria a lista vir vazia e os 2 testes
    // abaixo passariam por ausência de prova, não por ausência de rota (D157).
    expect(arquivos.length).toBeGreaterThan(500);
  });

  it('nenhum arquivo de src/ tem os padrões proibidos FORA de comentário', () => {
    const achados: Array<{ file: string; pattern: string }> = [];

    for (const file of arquivos) {
      const texto = semComentarios(fs.readFileSync(file, 'utf8'));
      for (const padrao of PADROES_PROIBIDOS) {
        if (texto.includes(padrao)) {
          achados.push({ file: path.relative(SRC_ROOT, file), pattern: padrao });
        }
      }
    }

    expect(achados).toEqual([]);
  });

  it('CONTROLE POSITIVO — comentário histórico que CITA a rota removida não derruba o teste', () => {
    // webhooksTest.ts documenta a remoção num comentário `//` — prova que o stripper de
    // comentário funciona (sem ele, este próprio arquivo derrubaria o teste acima).
    const alvo = path.join(SRC_ROOT, 'shared/openapi/registrations/webhooksTest.ts');
    const bruto = fs.readFileSync(alvo, 'utf8');
    expect(bruto).toMatch(/clickup\/patient/); // o comentário existe de verdade...
    expect(semComentarios(bruto)).not.toMatch(/clickup\/patient/); // ...e o stripper o remove
  });
});
