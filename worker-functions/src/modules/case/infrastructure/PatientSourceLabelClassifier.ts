import { tetoDoCampo, PatientSourceLabelCeilingError } from './PatientSourceLabelCeiling';
import type { PatientSourceLabelRejection } from './PatientSourceLabelRead';

/**
 * PatientSourceLabelClassifier — a decisão PURA: o que entra, o que é ausência, o que é recusa.
 *
 * Extraído de `PatientSourceLabelRepository` pelo teto de 400 linhas. Puro, testável sem banco
 * — que era exatamente o que a seção "Puro, testável sem banco" daquele arquivo já dizia; aqui
 * a fronteira deixa de ser um comentário e passa a ser o arquivo.
 */

export interface ClassifiedLabels {
  received: number;
  empty: number;
  accepted: string[];
  rejected: PatientSourceLabelRejection[];
}

/**
 * Decide o que entra, o que é ausência e o que é recusa — sem tocar no banco.
 *
 * LISTA DE PERMISSÃO, não de bloqueio (C5 do parecer): entra `string` com conteúdo. Todo o
 * resto é classificado explicitamente. O rótulo NÃO é aparado nem normalizado: 5 das 17
 * opções da lista do Javier terminam em NBSP (task 1.6), e "literal" quer dizer literal —
 * normalizar aqui seria inventar um rótulo que a origem não tem.
 */
export function classify(
  labels: readonly unknown[] | null | undefined,
  /**
   * ⚠️ O teto é POR CAMPO desde a migration 306, então `classify` precisa saber de qual campo
   * se trata. Default `''` cai no teto padrão (3) — nenhum chamador antigo muda de comportamento,
   * e quem quer o teto maior tem de dizer qual campo é.
   */
  fieldName = '',
): ClassifiedLabels {
  const entrada = labels ?? [];
  const accepted: string[] = [];
  const rejected: PatientSourceLabelRejection[] = [];
  let empty = 0;

  for (const value of entrada) {
    // Ausência é ausência: `null`/`undefined` é o campo que ninguém preencheu — o caso
    // legítimo de 1424 de 1690 tarefas (F51). Não é recusa e não vira registro.
    if (value === null || value === undefined) {
      empty += 1;
      continue;
    }

    if (typeof value !== 'string') {
      // Número, booleano, objeto, array: a origem entregou algo que não é rótulo. Isso é
      // defeito, não vazio — e a C5 mostrou que `Number()` transforma vários deles num
      // orderindex válido se ninguém barrar.
      rejected.push({ rawLabel: descreve(value), reason: 'blank' });
      continue;
    }

    if (value.trim() === '') {
      rejected.push({ rawLabel: value, reason: 'blank' });
      continue;
    }

    if (accepted.includes(value)) {
      rejected.push({ rawLabel: value, reason: 'duplicate' });
      continue;
    }

    const tetoDesteCampo = tetoDoCampo(fieldName);
    if (tetoDesteCampo !== null && accepted.length >= tetoDesteCampo) {
      rejected.push({ rawLabel: value, reason: 'ceiling' });
      continue;
    }

    accepted.push(value);
  }

  return { received: entrada.length, empty, accepted, rejected };
}

/** Descrição curta e limitada de um valor que não é rótulo. Vai para o BANCO, não para log. */
function descreve(value: unknown): string {
  let texto: string;
  try {
    texto = typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    texto = Object.prototype.toString.call(value);
  }
  if (texto === '' || texto === undefined) texto = Object.prototype.toString.call(value);
  return `[${typeof value}] ${texto}`.slice(0, 200);
}

export function firstFreeOrdinal(usados: readonly number[], fieldName: string): number {
  // ⚠️ O teto é POR CAMPO desde a migration 306. Com o teto fixo em 3 aqui, o banco aceitaria
  // o 4º dispositivo (CHECK permite até 5) e esta função devolveria erro — código mais estreito
  // que o banco é tão errado quanto o contrário, e mais difícil de achar.
  // Sem teto ⇒ a próxima posição livre é sempre alcançável; o limite superior aqui é só uma
  // trava de sanidade contra laço infinito, não uma regra de negócio.
  const teto = tetoDoCampo(fieldName) ?? Number.MAX_SAFE_INTEGER;
  for (let i = 1; i <= teto; i++) {
    if (!usados.includes(i)) return i;
  }
  // Inalcançável: quem chama já conferiu o teto. Fica explícito em vez de devolver teto+1 e
  // deixar o CHECK do banco explodir com uma mensagem que não diz de onde veio.
  throw new PatientSourceLabelCeilingError(fieldName, usados.length, teto);
}
