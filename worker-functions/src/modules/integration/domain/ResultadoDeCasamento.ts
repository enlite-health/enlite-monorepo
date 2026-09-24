export type Criterio = 'documento' | 'telefone_nome' | 'telefone_email';

export type MotivoAmbiguidade = 'multiplos-no-criterio' | 'criterios-discordam';

export type ResultadoDeCasamento =
  | { tipo: 'unico'; nurseId: number; criterios: Criterio[] }
  | { tipo: 'nenhum' }
  | { tipo: 'ambiguo'; candidatos: number[]; motivo: MotivoAmbiguidade; criterios: Criterio[] };
