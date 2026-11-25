/**
 * Spec 095, T-095-52: o webhook do Talentum (URL direta run.app, §3.3) só alcança o serviço se o
 * deploy de PRD mantiver ingress `all` + `allUsers` invoker. Em prd (medido, P1) isso vem de
 * `--allow-unauthenticated` e da ausência de flag de ingress restritivo no passo de deploy.
 *
 * O caminho do YAML vem de DEPLOY_CONTRACT_WORKFLOW_PATH (default: o workflow real), para a
 * sabotagem poder apontar para uma cópia. Não há parser de YAML nas dependências, então o passo
 * é isolado por texto: do `- name: 'Deploy to Cloud Run'` até o próximo `- name:` no mesmo nível,
 * sem as linhas de comentário (um comentário não pode satisfazer nem reprovar o contrato).
 */
import fs from 'fs';
import path from 'path';

const WORKFLOW_PATH =
  process.env.DEPLOY_CONTRACT_WORKFLOW_PATH ??
  path.resolve(__dirname, '../../../.github/workflows/backend-prd.yml');

function passoDeDeploy(yaml: string): string {
  const linhas = yaml.split('\n');
  const inicio = linhas.findIndex((l) => /^\s*-\s*name:\s*['"]?Deploy to Cloud Run['"]?\s*$/.test(l));
  if (inicio < 0) throw new Error('passo "Deploy to Cloud Run" não encontrado no workflow');
  const recuo = linhas[inicio].search(/\S/);
  const passo: string[] = [linhas[inicio]];
  for (const l of linhas.slice(inicio + 1)) {
    if (l.trim() !== '' && l.search(/\S/) <= recuo && /^\s*-\s/.test(l)) break;
    passo.push(l);
  }
  return passo.filter((l) => !l.trim().startsWith('#')).join('\n');
}

describe('contrato de deploy de PRD: webhook do Talentum (ingress all + allUsers)', () => {
  const passo = passoDeDeploy(fs.readFileSync(WORKFLOW_PATH, 'utf8'));

  it('o passo isolado é o deploy do worker-functions (controle: não é vazio)', () => {
    expect(passo).toContain('deploy-cloudrun');
    expect(passo).toContain('service: ${{ env.SERVICE_NAME }}');
    expect(passo).toContain('flags:');
  });

  it('mantém --allow-unauthenticated (allUsers invoker) no passo de deploy', () => {
    expect(passo).toContain('--allow-unauthenticated');
  });

  it('não restringe o ingress (internal / internal-and-cloud-load-balancing)', () => {
    expect(passo).not.toMatch(/--ingress[=\s]+internal/);
  });
});
