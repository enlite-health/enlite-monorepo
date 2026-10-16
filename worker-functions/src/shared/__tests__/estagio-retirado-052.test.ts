/**
 * Spec 052 (Fase 4) — o estágio de funil "Confirmado" saiu do produto. Esta varredura é a régua do
 * "nenhuma leitura fora de migration": reintroduzir a palavra em qualquer arquivo de produto, de
 * script ou de teste do backend deixa este teste vermelho. Sem ele a regra era só instrução.
 *
 * O valor é montado em duas partes de propósito: este arquivo e os testes que citam o valor retirado
 * não precisam de exceção na lista, e a varredura não se acusa a si mesma.
 *
 * Lado do front e do `e2e-prod`: `enlite-frontend/src/test/estagio-retirado-052.test.ts`.
 * Migrations ficam de fora (guardam o histórico do dado e a 520 move as linhas).
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const RETIRADO = ['CONFIRM', 'ED'].join('');
/** Palavra inteira (como `grep -w`) OU a chave `stage_<valor>` da ajuda do painel (`_` é caractere de palavra). */
const PADRAO = new RegExp(`\\b${RETIRADO}\\b|stage_${RETIRADO}`);

const BACK = resolve(__dirname, '../../..'); // worker-functions/
const RAIZES = ['src', 'scripts', 'tests'].map((d) => join(BACK, d));
const IGNORAR = new Set(['node_modules', 'dist', 'coverage', '.git']);

/**
 * LISTA EXPLÍCITA dos que podem conter a palavra — com o motivo. Entrada nova aqui exige justificativa
 * em revisão; entrada que deixa de conter a palavra reprova (a lista não apodrece).
 */
const PERMITIDOS: Record<string, string> = {
  // Homônimo: estado de VÍNCULO DE IDENTIDADE de paciente (reconciliação), nada a ver com o funil de candidatura.
  'src/modules/reconciliation/application/ClassifySourcesUseCase.ts': 'homônimo — estado do vínculo de identidade',
  'src/modules/reconciliation/domain/enums.ts': 'homônimo — estado do vínculo de identidade',
  'src/modules/reconciliation/infrastructure/IdentityLinkRepository.ts': 'homônimo — estado do vínculo de identidade',
  'tests/e2e/patient-reconciliation-repos.e2e.test.ts': 'homônimo — teste do vínculo de identidade',
  // Semeia o valor DE PROPÓSITO (o CHECK do banco só fecha na migration 521): é o teste da migration 520.
  'tests/e2e/confirmed-052-migration.e2e.test.ts': 'teste da migration 520 (semeia o valor retirado)',
};

function arquivos(dir: string, saida: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (IGNORAR.has(nome)) continue;
    const caminho = join(dir, nome);
    const st = statSync(caminho);
    if (st.isDirectory()) arquivos(caminho, saida);
    else if (st.size < 2_000_000) saida.push(caminho);
  }
  return saida;
}

function contem(caminho: string): boolean {
  const buf = readFileSync(caminho);
  if (buf.includes(0)) return false; // binário
  return PADRAO.test(buf.toString('utf8'));
}

describe('spec 052 — o estágio retirado não volta ao backend', () => {
  const todos = RAIZES.flatMap((r) => arquivos(r));
  const achados = todos.filter(contem).map((f) => relative(BACK, f).split('\\').join('/')).sort();

  it('a varredura enxerga arquivos de verdade (contagem zero é falha, não sucesso)', () => {
    expect(todos.length).toBeGreaterThan(500);
  });

  it('controle positivo: o padrão acha o valor e a chave da ajuda, e ignora os homônimos de grafia', () => {
    expect(PADRAO.test(`x === '${RETIRADO}'`)).toBe(true);
    expect(PADRAO.test(`kanban-column-${RETIRADO}`)).toBe(true);
    expect(PADRAO.test(`stage_${RETIRADO}`)).toBe(true);
    expect(PADRAO.test(`UN${RETIRADO}_WRITE`)).toBe(false);
    expect(PADRAO.test(`SLOT_${RETIRADO}_SLUG`)).toBe(false);
  });

  it('só a lista de permitidos contém a palavra (nenhum arquivo de produto, script ou teste novo)', () => {
    const fora = achados.filter((f) => !(f in PERMITIDOS));
    expect(fora).toEqual([]);
  });

  it('cada permitido ainda contém a palavra (a lista não apodrece)', () => {
    const semPalavra = Object.keys(PERMITIDOS).filter((f) => !achados.includes(f));
    expect(semPalavra).toEqual([]);
  });
});
