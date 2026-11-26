/**
 * TESTE DE CONTRATO — o que o cliente pode GRAVAR em `job_postings.status`: NADA (semaforo-da-vaga F4; antes: estado-automatico-do-paciente, F2).
 *
 * Duas cópias em TypeScript, uma verdade: `STATUS_GRAVAVEIS` / `CICLOS_DE_VIDA` do back (dono, `vacancyLifecycle.ts`) e as do front
 * (`enlite-frontend/src/domain/value-objects/vacancyLifecycle.ts`). Lê o ARQUIVO do front (molde `relationshipParity.contract.test.ts`).
 * O editor de estado da vaga e o select do wizard saíram: o teste prova que `STATUS_GRAVAVEIS` é vazio nas duas pontas, e a recusa
 * do servidor (400 `VACANCY_STATUS_NOT_WRITABLE`) é provada no e2e `vaga-sem-estado-manual.e2e.test.ts`.
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

  it('STATUS_GRAVAVEIS do front = STATUS_GRAVAVEIS do back', () => {
    expect(listaConst(dominioFront, 'STATUS_GRAVAVEIS')).toEqual([...STATUS_GRAVAVEIS]);
  });

  it('CICLOS_DE_VIDA do front = CICLOS_DE_VIDA do back', () => {
    expect(listaConst(dominioFront, 'CICLOS_DE_VIDA')).toEqual([...CICLOS_DE_VIDA]);
  });

  it('ninguém grava status: STATUS_GRAVAVEIS é vazio nas duas pontas (controle positivo: o regex achou as duas constantes)', () => {
    expect(listaConst(dominioFront, 'STATUS_GRAVAVEIS')).toEqual([]);
    expect([...STATUS_GRAVAVEIS]).toEqual([]);
  });

  it('o filtro da lista e o badge leem CICLOS_DE_VIDA / o ciclo, sem mapa de valores de banco', () => {
    const dados = lerFront('presentation/pages/admin/vacanciesData.ts');
    expect(dados).toContain('CICLOS_DE_VIDA');
    expect(dados).not.toMatch(/SEARCHING_REPLACEMENT|RAPID_RESPONSE|PENDING_ACTIVATION/);
    const badge = lerFront('presentation/components/atoms/VacancyLifecycleBadge/VacancyLifecycleBadge.tsx');
    expect(badge).not.toMatch(/SEARCHING|ON_HOLD|SUSPENDED|CLOSED|DE_BAJA/);
  });
});
