/**
 * admission-hosts.ts — gestão das atendentes de admissão por país.
 *
 * Enquanto a tela não existe, é por aqui que entra e sai gente. A tabela
 * `interview_hosts` já é dinâmica por construção: qualquer mudança vale na
 * PRÓXIMA consulta de disponibilidade, sem deploy e sem reiniciar o serviço.
 *
 * Uso:
 *   ts-node -r dotenv/config -r tsconfig-paths/register scripts/admission-hosts.ts <comando> [opções]
 *
 *   list                                    lista todas (ativas e inativas)
 *   add    --email X --country AR|BR [--name "Nome"]
 *   enable  --email X                       volta a receber agendamentos
 *   disable --email X                       para de receber (NÃO apaga)
 *
 * Todas as escritas exigem `--execute`; sem ele o script só mostra o que faria.
 *
 * ⚠️ Desativar é o caminho normal para quem sai. Apagar a linha não está aqui
 * de propósito: `admission_appointments.host_email` guarda quem atendeu cada
 * entrevista, e essa história tem que continuar legível depois que a pessoa
 * deixa o time.
 */

import { Pool } from 'pg';

type Country = 'AR' | 'BR';

interface Args {
  comando: string;
  email?: string;
  country?: Country;
  name?: string;
  execute: boolean;
}

function parseArgs(argv: string[]): Args {
  const [comando = ''] = argv;
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const country = get('--country');
  if (country !== undefined && country !== 'AR' && country !== 'BR') {
    throw new Error(`--country precisa ser AR ou BR (recebido: ${country})`);
  }
  return {
    comando,
    email: get('--email')?.trim().toLowerCase(),
    country: country as Country | undefined,
    name: get('--name'),
    execute: argv.includes('--execute'),
  };
}

function exigir<T>(valor: T | undefined, mensagem: string): T {
  if (valor === undefined || valor === '') throw new Error(mensagem);
  return valor;
}

async function list(pool: Pool): Promise<void> {
  const res = await pool.query<{
    email: string;
    display_name: string | null;
    country: string;
    active: boolean;
    created_at: Date;
  }>(
    `SELECT email, display_name, country, active, created_at
       FROM interview_hosts
      ORDER BY country, active DESC, email`,
  );

  if (res.rowCount === 0) {
    console.log('Nenhuma atendente cadastrada. Com a tabela vazia e o roster ligado,');
    console.log('NENHUM horário é oferecido ao público — é o comportamento declarado.');
    return;
  }

  console.log(`${'PAÍS'.padEnd(5)} ${'ESTADO'.padEnd(8)} ${'E-MAIL'.padEnd(36)} NOME`);
  for (const r of res.rows) {
    const estado = r.active ? 'ativa' : 'INATIVA';
    console.log(
      `${r.country.padEnd(5)} ${estado.padEnd(8)} ${r.email.padEnd(36)} ${r.display_name ?? ''}`,
    );
  }

  const ativasPorPais = res.rows.filter((r) => r.active).reduce<Record<string, number>>((acc, r) => {
    acc[r.country] = (acc[r.country] ?? 0) + 1;
    return acc;
  }, {});
  for (const pais of ['AR', 'BR']) {
    if (!ativasPorPais[pais]) {
      console.log(`\n⚠️  ${pais} está SEM atendente ativa: o país não oferece horário nenhum.`);
    }
  }
}

async function add(pool: Pool, args: Args): Promise<void> {
  const email = exigir(args.email, 'add exige --email');
  const country = exigir(args.country, 'add exige --country AR|BR');

  const existente = await pool.query<{ country: string; active: boolean }>(
    `SELECT country, active FROM interview_hosts WHERE email = $1`,
    [email],
  );
  if (existente.rowCount) {
    const r = existente.rows[0];
    console.log(`${email} já existe (país ${r.country}, ${r.active ? 'ativa' : 'inativa'}).`);
    console.log('Para reativar use `enable`; o e-mail é único na tabela.');
    return;
  }

  console.log(`${args.execute ? 'ADICIONANDO' : '[dry-run] adicionaria'} ${email} em ${country}`);
  if (!args.execute) return;

  await pool.query(
    `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1, $2, $3, true)`,
    [email, args.name ?? null, country],
  );
  console.log('OK — vale na próxima consulta de disponibilidade, sem deploy.');
}

async function setActive(pool: Pool, args: Args, ativa: boolean): Promise<void> {
  const email = exigir(args.email, `${ativa ? 'enable' : 'disable'} exige --email`);
  const verbo = ativa ? 'ATIVANDO' : 'DESATIVANDO';

  const atual = await pool.query<{ active: boolean }>(
    `SELECT active FROM interview_hosts WHERE email = $1`,
    [email],
  );
  if (!atual.rowCount) throw new Error(`${email} não está cadastrada.`);
  if (atual.rows[0].active === ativa) {
    console.log(`${email} já está ${ativa ? 'ativa' : 'inativa'} — nada a fazer.`);
    return;
  }

  console.log(`${args.execute ? verbo : `[dry-run] ${verbo.toLowerCase()}`} ${email}`);
  if (!args.execute) return;

  await pool.query(`UPDATE interview_hosts SET active = $2 WHERE email = $1`, [email, ativa]);
  console.log('OK — vale na próxima consulta de disponibilidade, sem deploy.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL não definida.');

  const pool = new Pool({ connectionString });
  try {
    switch (args.comando) {
      case 'list':
        await list(pool);
        break;
      case 'add':
        await add(pool, args);
        break;
      case 'enable':
        await setActive(pool, args, true);
        break;
      case 'disable':
        await setActive(pool, args, false);
        break;
      default:
        console.log('Comandos: list | add | enable | disable   (escrita exige --execute)');
        process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`ERRO: ${(err as Error).message}`);
  process.exit(1);
});
