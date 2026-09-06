# `wp/jobs/` — código NOSSO que roda no WordPress `jobs.enlite.health`

O portal de vagas é um WordPress no Cloudways (sem SSH, sem git no servidor). O plugin de terceiro
`filtro-avancado-vacantes` puxa o feed `GET /api/public/v1/jobs` por WP-Cron (5 min) e renderiza a lista.
**Nada do que é nosso pode ter como único exemplar um servidor de terceiro** — por isso esta pasta.

| arquivo | vai para | o que faz |
|---|---|---|
| `mu-plugins/enlite-vaga-cache-purge.php` | `public_html/wp-content/mu-plugins/` | purga o page-cache do Breeze quando uma vaga muda DE VERDADE (D219 / PEND-08) |
| `tests/enlite-vaga-cache-purge.test.php` | (não vai) | harness PHP puro: `php wp/jobs/tests/enlite-vaga-cache-purge.test.php` → `OK: n/n`; `MODE=purge php …` idem |

Ainda **não** versionados aqui (existem só no servidor — task própria, D219): `filtro-avancado-vacantes`
(com edições nossas de 13/07 e 27/07) e os mu-plugins `disable-shortcm-for-vagas.php`, `0-worker.php`.

## Por que este mu-plugin existe (medido 29/08/2026)
O sync reescreve os 187 posts a cada 5 min (`wp_update_post` sem comparar), então `save_post` dispara sempre
e o purge por post do Breeze não alcança a listagem `/es/`; o Breeze tem TTL 1440 min e o plugin nunca purga.
Resultado medido: `/es/` servida com `Last modified` de 05:01 às 21:51 (17 h velha). A única escrita do ciclo que
só acontece em mudança real é `update_post_meta` (o core não dispara `updated_post_meta` para valor idêntico) —
é nela que o mu-plugin escuta, mais `transition_post_status` (≠) e `deleted_post`. Uma purga por request, no
`shutdown`.

## Deploy (SFTP, checklist de 27/07 — memória `portal-jobs-wordpress`)
1. `php -l` + harness verdes.
2. `put` em `public_html/wp-content/mu-plugins/enlite-vaga-cache-purge.php`. Backup não se aplica (arquivo novo);
   rollback = `rm` do arquivo.
3. **Fase log-only (como nasce, `ENLITE_VAGA_PURGE_MODE = 'log'`):** esperar 3 ciclos de cron (~15 min) SEM editar
   vaga; `curl -u "$WP_USER:$WP_APP" https://jobs.enlite.health/wp-json/enlite/v1/vaga-purge-stats` tem de
   mostrar `count: 0`. Se subir sozinho, a viga caiu — NÃO ligar `purge`; ver D219.
4. **Ligar:** trocar `'log'` por `'purge'` na `define`, `put` de novo. Provar os DOIS lados: (negativo) sem edição a
   `/es/` continua servida do cache por > 5 min (`<!-- Cache served by breeze CACHE - Last modified: … -->` não
   muda); (positivo) editar a descrição de UMA vaga no painel → `count` +1 no ciclo seguinte e a `/es/` canônica
   muda em ≤ 6 min. Registrar o tempo medido.
5. Ler ao vivo com `?nc=<ts>` fura o Breeze — serve para ver o dinâmico, **não** para provar a purga.
