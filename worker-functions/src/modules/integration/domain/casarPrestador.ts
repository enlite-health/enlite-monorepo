import { ResultadoDeCasamento, Criterio } from './ResultadoDeCasamento';
import { normalizarNome, normalizarTelefone, normalizarDocumento } from './normalizacaoDeCasamento';

export interface WorkerParaCasar {
  documento: string | null;
  telefone: string | null;
  email: string | null;
  nome: string | null;
}

export interface EnfermeiraParaCasar {
  id: number;
  cedula_ciudadania: string | null;
  telefono: string | null;
  email: string | null;
  nombre: string | null;
  apellidos: string | null;
}

type CriterioResult = { nenhum: true } | { um: number } | { varios: number[] };

function casarPorDocumento(worker: WorkerParaCasar, enfermeiras: EnfermeiraParaCasar[]): CriterioResult {
  const workerNormalized = normalizarDocumento(worker.documento);

  // Se o documento normalizado do worker for null, retorna {nenhum} imediatamente
  if (workerNormalized === null) {
    return { nenhum: true };
  }

  const matches = new Set<number>();

  for (const enfermeira of enfermeiras) {
    const enfermeiraNormalized = normalizarDocumento(enfermeira.cedula_ciudadania);

    // Se o documento normalizado da enfermeira for null, não casa
    if (enfermeiraNormalized === null) {
      continue;
    }

    if (enfermeiraNormalized === workerNormalized) {
      matches.add(enfermeira.id);
    }
  }

  if (matches.size === 0) {
    return { nenhum: true };
  } else if (matches.size === 1) {
    return { um: Array.from(matches)[0] };
  } else {
    return { varios: Array.from(matches) };
  }
}

function casarPorTelefoneNome(worker: WorkerParaCasar, enfermeiras: EnfermeiraParaCasar[]): CriterioResult {
  const workerTelefonNormalized = normalizarTelefone(worker.telefone);
  const workerNomeNormalized = normalizarNome(worker.nome || '');

  // Se o telefone normalizado for vazio/nulo, retorna {nenhum} imediatamente
  if (!workerTelefonNormalized) {
    return { nenhum: true };
  }

  // Se o nome normalizado for vazio, retorna {nenhum} imediatamente
  if (!workerNomeNormalized) {
    return { nenhum: true };
  }

  const matches = new Set<number>();

  for (const enfermeira of enfermeiras) {
    const enfermeiraTelefonNormalized = normalizarTelefone(enfermeira.telefono);
    const enfermeiraNomeNormalized = normalizarNome(`${enfermeira.nombre || ''} ${enfermeira.apellidos || ''}`);

    // Se o telefone normalizado da enfermeira for vazio/nulo, não casa
    if (!enfermeiraTelefonNormalized) {
      continue;
    }

    // Se o nome normalizado da enfermeira for vazio, não casa
    if (!enfermeiraNomeNormalized) {
      continue;
    }

    if (enfermeiraTelefonNormalized === workerTelefonNormalized && enfermeiraNomeNormalized === workerNomeNormalized) {
      matches.add(enfermeira.id);
    }
  }

  if (matches.size === 0) {
    return { nenhum: true };
  } else if (matches.size === 1) {
    return { um: Array.from(matches)[0] };
  } else {
    return { varios: Array.from(matches) };
  }
}

function casarPorTelefoneEmail(worker: WorkerParaCasar, enfermeiras: EnfermeiraParaCasar[]): CriterioResult {
  const workerTelefonNormalized = normalizarTelefone(worker.telefone);
  const workerEmailNormalized = String(worker.email || '').trim().toLowerCase();

  // Se o telefone normalizado for vazio/nulo, retorna {nenhum} imediatamente
  if (!workerTelefonNormalized) {
    return { nenhum: true };
  }

  // Se o e-mail for vazio, retorna {nenhum} imediatamente
  if (!workerEmailNormalized) {
    return { nenhum: true };
  }

  const matches = new Set<number>();

  for (const enfermeira of enfermeiras) {
    const enfermeiraTelefonNormalized = normalizarTelefone(enfermeira.telefono);
    const enfermeiraEmailNormalized = String(enfermeira.email || '').trim().toLowerCase();

    // Se o telefone normalizado da enfermeira for vazio/nulo, não casa
    if (!enfermeiraTelefonNormalized) {
      continue;
    }

    // Se o e-mail da enfermeira for vazio, não casa
    if (!enfermeiraEmailNormalized) {
      continue;
    }

    if (enfermeiraTelefonNormalized === workerTelefonNormalized && enfermeiraEmailNormalized === workerEmailNormalized) {
      matches.add(enfermeira.id);
    }
  }

  if (matches.size === 0) {
    return { nenhum: true };
  } else if (matches.size === 1) {
    return { um: Array.from(matches)[0] };
  } else {
    return { varios: Array.from(matches) };
  }
}

export function casarPrestador(worker: WorkerParaCasar, enfermeiras: EnfermeiraParaCasar[]): ResultadoDeCasamento {
  // Calcular resultado para cada critério
  const v: Record<Criterio, CriterioResult> = {
    documento: casarPorDocumento(worker, enfermeiras),
    telefone_nome: casarPorTelefoneNome(worker, enfermeiras),
    telefone_email: casarPorTelefoneEmail(worker, enfermeiras),
  };

  // Listar os critérios que deram "um" ou "varios"
  const criteriosComResultado: Criterio[] = [];
  const idsDosCriteriosUm = new Set<number>();

  for (const criterio of ['documento', 'telefone_nome', 'telefone_email'] as Criterio[]) {
    const resultado = v[criterio];

    // Se algum critério deu "varios", já retorna ambiguo com motivo 'multiplos-no-criterio'
    if ('varios' in resultado) {
      criteriosComResultado.push(criterio);
      const candidatos = new Set<number>(resultado.varios);

      // Coletar também os ids dos critérios "um"
      for (const criterio2 of ['documento', 'telefone_nome', 'telefone_email'] as Criterio[]) {
        const resultado2 = v[criterio2];
        if ('um' in resultado2) {
          candidatos.add(resultado2.um);
        }
      }

      return {
        tipo: 'ambiguo',
        candidatos: Array.from(candidatos),
        motivo: 'multiplos-no-criterio',
        criterios: criteriosComResultado,
      };
    }

    // Se deu "um", adicionar à lista
    if ('um' in resultado) {
      criteriosComResultado.push(criterio);
      idsDosCriteriosUm.add(resultado.um);
    }
  }

  // Verificar se os critérios "um" apontam para IDs distintos
  if (idsDosCriteriosUm.size >= 2) {
    return {
      tipo: 'ambiguo',
      candidatos: Array.from(idsDosCriteriosUm),
      motivo: 'criterios-discordam',
      criterios: criteriosComResultado,
    };
  }

  // Se temos exatamente 1 ID único
  if (idsDosCriteriosUm.size === 1) {
    return {
      tipo: 'unico',
      nurseId: Array.from(idsDosCriteriosUm)[0],
      criterios: criteriosComResultado,
    };
  }

  // Nenhum critério deu "um", então nenhum match
  return { tipo: 'nenhum' };
}
