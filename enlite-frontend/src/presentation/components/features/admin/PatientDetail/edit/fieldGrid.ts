/**
 * Linha de campos do drawer de serviço: rótulo alinha com rótulo e input com input MESMO com rótulo longo (Gabriel, 21/10).
 * Cada campo é uma célula com 3 trilhas (rótulo · input · dica) herdadas da grade por `subgrid`: o rótulo que quebra em duas
 * linhas estica a trilha dos DOIS campos, em vez de empurrar um input só. Abaixo de `sm` a grade é uma coluna e nada disso se aplica.
 */
export const FIELD_GRID = 'grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0';
export const FIELD_CELL = 'mb-3 sm:row-span-3 sm:grid sm:grid-rows-subgrid sm:gap-y-1';
