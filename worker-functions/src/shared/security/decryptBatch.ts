/**
 * Tamanho do lote de descriptografia KMS.
 *
 * Nasceu em `AdminWorkersMapController` (o mapa de prestadores, que descriptografa
 * endereço de centenas de workers por request). Mora aqui desde 31/08 porque um
 * SEGUNDO caminho passou a precisar dela — a listagem de pacientes — e importar
 * uma constante de `interfaces/controllers` para dentro de `infrastructure`
 * quebrava a camada: era o ÚNICO import desse tipo no repositório, e ainda
 * atravessando módulo (`case` → `worker`).
 *
 * Por que existe: `Promise.all` sobre a página inteira dispara uma chamada por
 * linha ao mesmo tempo. Com o teto de 500 do `adminPatientsListSchema` isso são
 * 500 requisições simultâneas ao KMS numa única request HTTP — quota e latência.
 * Em lotes de 50 o custo total é o mesmo e a concorrência fica limitada.
 */
export const DECRYPT_BATCH = 50;
