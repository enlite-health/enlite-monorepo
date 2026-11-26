/**
 * TESTE DE CONTRATO — o que o cliente pode GRAVAR em `job_postings.status` (estado-automatico-do-paciente, F2, D3/E5).
 *
 * Duas cópias em TypeScript, uma verdade: `STATUS_GRAVAVEIS` / `CICLOS_DE_VIDA` do back (dono, `vacancyLifecycle.ts`) e as do front
 * (`enlite-frontend/src/domain/value-objects/vacancyLifecycle.ts`). Lê o ARQUIVO do front (molde `relationshipParity.contract.test.ts`)
 * e confere que o editor da vaga e o wizard usam a constante do front em vez de lista literal própria.
 *
 * Se falhar, NÃO edite a lista esperada: ajuste o front (ou o dono) para bater.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CICLOS_DE_VIDA, STATUS_GRAVAVEIS } from '../domain/vacancyLifecycle';

const FRONT = join(__dirname, '../../../../../enlite-frontend/src');
const lerFront = (rel: string): string => readFileSync(join(FRONT, rel), 'utf8');

/** Valores de `export const <nome> = [ 'A', 'B' ] as const;` lidos do fonte. */
function listaConst(fonte: string, nome: string): string[] {
  const m = new RegExp(`export const ${nome}\\s*=\\s*\\[([^\\]]*)\\]\\s*as const`).exec(fonte);
  expect(m).not.toBeNull(); // contagem zero é falha: o regex TEM de achar a constante
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('contrato: lista gravável e ciclos de vida — front = back', () => {
  const dominioFront = lerFront('domain/value-objects/vacancyLifecycle.ts');

  it('STATUS_GRAVAVEIS do front = STATUS_GRAVAVEIS do back (mesma ordem)', () => {
    expect(listaConst(dominioFront, 'STATUS_GRAVAVEIS')).toEqual([...STATUS_GRAVAVEIS]);
  });

  it('CICLOS_DE_VIDA do front = CICLOS_DE_VIDA do back', () => {
    expect(listaConst(dominioFront, 'CICLOS_DE_VIDA')).toEqual([...CICLOS_DE_VIDA]);
  });

  it('o editor da vaga e o wizard LEEM a constante do front — nenhuma lista literal de status de vaga neles', () => {
    const editor = lerFront('presentation/components/features/admin/VacancyDetail/VacancyStatusEditor.tsx');
    const wizard = lerFront('presentation/components/features/admin/vacancy-form-schema.ts');
    expect(editor).toContain("STATUS_GRAVAVEIS");
    expect(editor).toContain("@domain/value-objects/vacancyLifecycle");
    expect(wizard).toMatch(/export const STATUS_OPTIONS = STATUS_GRAVAVEIS/);
    for (const fonte of [editor, wizard]) {
      expect(fonte).not.toMatch(/SEARCHING_REPLACEMENT|RAPID_RESPONSE|PENDING_ACTIVATION/);
    }
  });

  it('o filtro da lista e o badge leem CICLOS_DE_VIDA / o ciclo, sem mapa de valores de banco', () => {
    const dados = lerFront('presentation/pages/admin/vacanciesData.ts');
    expect(dados).toContain('CICLOS_DE_VIDA');
    expect(dados).not.toMatch(/SEARCHING_REPLACEMENT|RAPID_RESPONSE|PENDING_ACTIVATION/);
    const badge = lerFront('presentation/components/atoms/VacancyLifecycleBadge/VacancyLifecycleBadge.tsx');
    expect(badge).not.toMatch(/SEARCHING|ON_HOLD|SUSPENDED|CLOSED|DE_BAJA/);
  });
});
