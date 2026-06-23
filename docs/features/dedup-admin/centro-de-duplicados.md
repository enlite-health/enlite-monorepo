# Centro de Duplicados (`/admin/dedup`)

> Tela administrativa (só **admin**) para encontrar e unificar contas de **workers (prestadores) duplicadas** no banco — sem precisar de Excel nem de mexer no banco direto.

## Por que existe

A base de workers acumulou **duplicatas**: a mesma pessoa apareceu mais de uma vez (cadastro repetido, importações de Talentum/ClickUp/planilhas, reconciliação por telefone falha, etc.). Conta duplicada quebra a operação: histórico de postulações/documentos/entrevistas fica espalhado entre dois registros, relatórios contam a pessoa duas vezes, e o recrutamento não sabe qual conta é a "boa".

O Centro de Duplicados resolve isso com uma ação central: **unificar** (merge). Unificar = escolher uma conta **principal** (a que fica) e **absorver** a(s) outra(s) nela. Todos os dados ligados (postulações, documentos, entrevistas, disponibilidade, zonas…) são **re-vinculados** à principal; a absorvida é marcada como mesclada (`merged_into_id`) e some das listas. **Nada é apagado** e **todo merge tem desfazer** (snapshot).

### Conceitos que aparecem em todas as abas

- **Conta real vs. importada/fantasma** — uma conta é **real** quando tem login de verdade (Firebase) e e‑mail real. É **importada** quando o e‑mail termina em `@enlite.import` (veio de import em massa, nunca logou). O sistema usa isso pra **sugerir** qual conta deve ser a principal (a real ganha da importada) e pra **bloquear** casos perigosos (duas reais → revisão manual).
- **Principal (survivor)** — a conta que **fica** após a unificação.
- **Absorvida** — a conta que é **mesclada** na principal e sai de cena.
- **O que acontece com os campos** — por padrão a principal mantém os dados dela e os campos **vazios** são preenchidos pela absorvida (não sobrescreve, não perde nada). Na unificação você pode abrir **"Avanzado"** e escolher, **campo a campo**, qual valor fica.

A tela tem **3 abas** (Fila, Historial, Importados) e o botão **"Unificar manualmente"** no topo.

---

## Aba **Fila** (`Fila`)

**O que é:** a fila automática de duplicatas detectadas por **mesmo telefone**. Quando dois ou mais workers têm o **mesmo telefone normalizado** (`phone_normalized`), são quase certamente a mesma pessoa — é o sinal de duplicata de **maior confiança**. É aqui que o operador faz o trabalho do dia a dia.

**Proposta:** dar uma lista priorizada e segura de grupos pra revisar e unificar (ou descartar se não for duplicata).

### Colunas

| Coluna (es‑AR) | O que mostra | Por que existe |
|---|---|---|
| ☑ (checkbox) | Seleção da linha | Permite **ação em lote** (unificar/descartar vários grupos de uma vez) sem abrir um por um. |
| **Teléfono** | O telefone normalizado do grupo (`phone_normalized`, ex. `5491134567890`) | É a **chave** que agrupou as contas — o motivo de elas estarem juntas. Identifica o grupo de forma humana (telefone, não ID interno). |
| **Cuentas** | Quantas contas há no grupo (2, 3, …) | Mostra o **tamanho** da duplicata — quantos registros vão virar um só. |
| **Cuentas reales** | Badge: quantas das contas têm login real (ex. *"2 reales"*, *"1 real · 1 prueba"*) | É o **sinal de risco/decisão**: se há **1 real** o merge é tranquilo (a real absorve a fantasma); se há **2+ reais** é preciso cuidado (pode ser gente diferente). |
| **Alta** | Data de criação da conta **mais antiga** do grupo | Ajuda a julgar qual é a conta "original" e dá contexto temporal (duplicata nova vs. antiga). |
| **Acciones** | **Unificar** (abre a tela de comparar e mesclar) · **Descartar** (marca que não é duplicata e tira da fila) | As duas decisões possíveis: ou **é** duplicata → unifica, ou **não é** → descarta pra não reaparecer. |

> Observação: a coluna "Principal sugerido" foi **removida** da Fila (aparecia sempre vazia e confundia). A sugestão de principal aparece **dentro** da tela de comparação, ao clicar em Unificar.

---

## Aba **Historial** (`Historial`)

**O que é:** o **registro de todas as unificações já feitas** — tanto a limpeza inicial em massa quanto cada merge feito pelo operador.

**Proposta:** transparência e **auditoria** — saber o que foi unificado, de quem, quando, e poder **desfazer** se algo saiu errado.

### Colunas

| Coluna (es‑AR) | O que mostra | Por que existe |
|---|---|---|
| **Teléfono** | Telefone do grupo que foi unificado | Liga o registro ao grupo original de forma humana. |
| **Cuenta principal** | **Nome** da conta que ficou (decriptado, só admin) | Pra você ver **quem ficou** sem precisar decorar UUID. Cai pra "(importado)"/"(sin nombre)" quando não há nome. |
| **Cuenta absorbida** | **Nome** da conta que foi absorvida | Pra confirmar **quem saiu** na unificação. |
| **Categoría** | Motivo/critério da unificação, em label humana (ex. *"Cuenta con acceso"*, *"Datos más completos"*, *"Sin actividad"*) | Explica **por que** aquela conta foi escolhida como principal — sem mostrar o código interno (`firebase`/`most_complete`/`ghost`). |
| **Fecha** | Data/hora da unificação | Quando aconteceu — ordena o histórico e dá contexto. |
| **Acciones** | **Deshacer** (quando há snapshot) ou `—` | Permite **reverter** o merge (reativa a absorvida e devolve os dados). Aparece `—` quando o merge não tem snapshot (ex. a limpeza inicial em massa, anterior ao motor de undo). |

---

## Aba **Importados** (`Importados`)

**O que é:** grupos de contas suspeitas de serem a mesma pessoa, detectados por **semelhança de NOME** (não por telefone). São, em geral, os **fantasmas importados** (`@enlite.import`) que casam por nome com uma conta real ou com outro importado.

**Proposta:** atacar o estoque de duplicatas que **não compartilham telefone** (por isso não caem na Fila). É um terreno de **menor confiança** — nome igual não garante mesma pessoa — então a aba avisa pra revisar com cuidado e **bloqueia** os casos arriscados.

### Colunas

| Coluna (es‑AR) | O que mostra | Por que existe |
|---|---|---|
| **Cuentas** | Quantas contas há no grupo por nome | Tamanho da duplicata candidata. |
| **Cuentas reales** | Badge real vs. prueba (igual à Fila) | Sinal de risco: define se o grupo é seguro (1 real) ou conflito (2+ reais). |
| **Principal sugerido** | A conta sugerida pra ficar (e‑mail + status) + badge de status | Mostra **qual conta o sistema indica** como principal antes de você abrir. |
| **Alta** | Data da conta **mais antiga** do grupo | Contexto temporal / qual é a mais "original". |
| **Razón** | Por que o grupo foi classificado assim: *"Real absorbe importado"*, *"Conflicto: múltiples reales"*, *"Más completo"* | Explica a **lógica da sugestão** e, principalmente, sinaliza quando é **conflito** (precisa de decisão humana). |
| **Acciones** | **Revisar/Unificar** (abre comparar e mesclar) — desabilitado/avisando quando é conflito de múltiplas reais | A ação de resolver o grupo. Em conflito (2+ reais) manda revisar manualmente em vez de mesclar às cegas. |

---

## Botão **"Unificar manualmente"** (topo da página)

**O que é:** unificação **sob demanda** de **duas contas quaisquer**, mesmo que **não estejam em nenhuma aba** (não compartilham telefone nem foram pescadas por nome).

**Proposta:** dar autonomia ao operador pra resolver casos que a detecção automática não pegou. Ele busca a **primeira conta** e depois a **segunda** num campo com **autocomplete** (por **nome ou telefone**, mostrando *nome · telefone · "Con acceso"/"Importado"*), e cai na **mesma** tela de comparar e mesclar — com **seleção campo a campo** (seção "Avanzado") igual à Fila.

**Regra de segurança:** se as duas contas escolhidas forem **ambas reais**, a unificação é **bloqueada** ("Revisión manual requerida") — pra não fundir, por engano, duas pessoas diferentes.

---

## Tela de comparação ("Comparar y unificar")

Aberta por qualquer "Unificar" (Fila, Importados ou manual). Mostra um **card por conta** com nome, telefone, status (ex. "Registrado"), métricas (Postulaciones / Documentos / Encuadres) e selo "Login real". Você:

1. Escolhe a **principal** ("Hacer principal").
2. (Opcional) Abre **"Avanzado"** e escolhe, por campo em conflito, qual valor fica — cada opção é rotulada pelo **nome** da conta de origem.
3. Confirma em **"Confirmar unificación"**. Tudo é re‑vinculado à principal, a absorvida sai, e a ação fica no **Historial** com **Deshacer**.

---

## Onde está no código (referência rápida pra devs)

- Página/abas: `enlite-frontend/src/presentation/pages/admin/DedupCenterPage/` (`DedupGroupList` = Fila, `DedupHistoryTab` = Historial, `ImportedGroupsTab` = Importados).
- Comparar/mesclar: `enlite-frontend/src/presentation/components/features/admin/Dedup/` (`MergeCompareModal`, `MergePhoneModeBody` = Fila, `MergeDirectModeBody` = Importados/manual, `MergeAdvancedFields` = chooser campo‑a‑campo, `ManualMergeModal` = busca manual).
- Backend: `worker-functions/src/application/dedup/` (use cases) + `interfaces/controllers/dedup/` (7+ endpoints sob `/api/admin/dedup`). Motor de merge/undo: `infrastructure/services/WorkerPhoneMerge*`.
