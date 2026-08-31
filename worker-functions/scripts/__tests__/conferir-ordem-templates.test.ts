/**
 * conferir-ordem-templates.test.ts — o instrumento tinha o defeito que ele existe
 * para achar.
 *
 * `skeleton()` normaliza os dois textos trocando cada variável pelo seu índice,
 * para comparar ORDEM. Ele usava `[^}]+?` enquanto a ordem vem de
 * `extractPlaceholders` (`[A-Za-z0-9_]+`): um placeholder com hífen não entrava na
 * lista de ordem, virava «0» dos DOIS lados, e o script dizia "igual" para textos
 * diferentes — um ✅ falso justamente onde ele deveria gritar.
 */
import { skeleton } from '../conferir-ordem-templates';

describe('skeleton — a régua de ordem não pode colapsar placeholders distintos', () => {
  it('placeholder fora de [A-Za-z0-9_] NÃO colapsa: textos diferentes continuam diferentes', () => {
    expect(skeleton('Hola {{first-name}}, caso {{case_number}}'))
      .not.toBe(skeleton('Hola {{last-name}}, caso {{case_number}}'));
  });

  it('mesma ordem dos dois lados → mesmo esqueleto (é assim que ele aprova)', () => {
    expect(skeleton('Hola {{worker_name}}, caso {{case_number}}', 'nomeado'))
      .toBe(skeleton('Hola {{1}}, caso {{2}}', 'posicional'));
  });

  it('numeração PERMUTADA na Twilio → esqueletos diferentes (era o ponto cego)', () => {
    // O envio põe case_number no slot 1 e worker_name no 2; o template aprovado
    // espera o contrário. Normalizando os dois pela ordem de aparição, isto
    // passava como "igual" — e é exatamente a troca de valores que o instrumento
    // existe para achar.
    expect(skeleton('Caso {{case_number}} para {{worker_name}}', 'nomeado'))
      .not.toBe(skeleton('Caso {{2}} para {{1}}', 'posicional'));
  });

  it('normaliza espaço em branco e tolera corpo sem variável', () => {
    expect(skeleton('linha\n\n  outra')).toBe('linha outra');
    expect(skeleton('')).toBe('');
    // modo posicional com nome (não deveria acontecer, mas não pode explodir)
    expect(skeleton('Hola {{nombre}}', 'posicional')).toBe('Hola «1»');
  });
});
