-- 303_transit_stops.sql
-- Paradas de transporte público — o insumo do CORREDOR LOGÍSTICO do /admin/mapa.
--
-- POR QUÊ: a pergunta que a recrutadora faz ao olhar o mapa não é "quantos km",
-- é "dá para chegar?". O terreno decide o formato da resposta: em Buenos Aires
-- NÃO EXISTE TERMINAL — Marcel, 02/09: "tu tem que descer da parada dele, andar
-- para outra parada e pegar outra. E tu, além de tudo, tu paga de novo". Por isso
-- a resposta boa é UMA LINHA servindo as duas pontas (o pedido original fala em
-- "alcançável por UM meio — coletivo, trem ou metrô"), e a baldeação é a exceção
-- que se sinaliza, não o produto. O que a operação escreve à mão hoje no campo
-- `acceso` do ClickUp tem exatamente esta forma: "a três quadras, acessa por
-- colectivo tal".
--
-- ⚠️ POR QUE NÃO É GTFS: o GTFS aberto de Buenos Aires está SUSPENSO no portal
-- oficial, e o que ainda se baixa é conteúdo morto — medido em 05/09/2026: o
-- `calendar.txt` do feed de trens expira em 30/04/2020 e o do subte em 31/12/2021;
-- os espelhos (Mobility Database, transitland) são download NOVO do mesmo arquivo
-- VELHO. Um roteador sobre isso daria horário de partida ficcional. Esta tabela
-- guarda o que existe fresco e é suficiente para a pergunta acima: PARADAS com as
-- LINHAS que passam nelas (GCBA, 28/10/2024, CC-BY-2.5-AR). Sem grade de horários,
-- e por isso a tela NÃO promete horário — promete corredor.
--
-- 🔒 ESTA TABELA NÃO TEM TITULAR. É infraestrutura pública: nenhuma coluna, FK ou
-- índice pode ligá-la a `workers`, `patients` ou `patient_addresses`. É essa
-- ausência que sustenta o parecer do lex (05/09): o cálculo do corredor acontece
-- INTEIRO dentro do nosso perímetro, nenhuma coordenada de domicílio sai para
-- terceiro, e não há cesión a controlador independente (Ley 25.326 art. 11) nem
-- transferência internacional (art. 12) para analisar. Quem for acrescentar coluna
-- aqui: se ela referir uma pessoa, a tabela muda de regime e o parecer cai junto.
--
-- `country` existe por correção operacional (AR ≠ BR), não por RLS: sem titular
-- não há isolamento de titular a fazer. `feed_id` identifica a origem para a
-- recarga ser idempotente e para uma fonte poder ser trocada sem apagar as outras.
--
-- Idempotente: IF NOT EXISTS em tudo.

BEGIN;

CREATE TABLE IF NOT EXISTS transit_stops (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Origem do dado (ex.: 'gcba-colectivos-2024-10-28'). A recarga apaga e reinsere
  -- POR feed, então trocar a fonte de colectivos não derruba as estações de trem.
  feed_id       TEXT        NOT NULL,
  country       TEXT        NOT NULL CHECK (country IN ('AR', 'BR')),
  -- Id da parada NA FONTE. Único dentro do feed — é a chave da recarga idempotente.
  external_id   TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  latitude      NUMERIC(10, 7) NOT NULL,
  longitude     NUMERIC(10, 7) NOT NULL,
  -- Modo: 'bus' | 'train' | 'subway'. Texto e não enum porque a lista cresce com a
  -- fonte, e um enum obrigaria migration para acrescentar 'tram'.
  mode          TEXT        NOT NULL,
  -- As linhas que param AQUI (ex.: {'8','24','50'}). É o que responde "que linha
  -- serve os dois pontos" sem precisar de nenhuma tabela de rotas.
  lines         TEXT[]      NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A chave da recarga: reimportar o mesmo feed atualiza em vez de duplicar.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transit_stops_feed_external
  ON transit_stops (feed_id, external_id);

-- Coluna geography gerada, no mesmo molde de `worker_service_areas` (migration 084):
-- é ela que o ST_DWithin do corredor percorre.
ALTER TABLE transit_stops
  ADD COLUMN IF NOT EXISTS location public.geography(point, 4326)
  GENERATED ALWAYS AS (
    ST_SetSRID(ST_MakePoint(longitude::float8, latitude::float8), 4326)::geography
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_transit_stops_location
  ON transit_stops USING GIST (location);

-- O corredor sempre pergunta dentro de um país e de um modo.
CREATE INDEX IF NOT EXISTS idx_transit_stops_country_mode
  ON transit_stops (country, mode);

COMMENT ON TABLE transit_stops IS
  'Paradas de transporte público (infraestrutura pública, SEM TITULAR). Insumo do corredor logístico do /admin/mapa: responde "que linha serve os dois pontos e a quantas quadras". NÃO acrescentar coluna que refira pessoa — a ausência de titular é o que mantém o cálculo dentro do perímetro e fora do regime de cesión (parecer lex 05/09/2026).';
COMMENT ON COLUMN transit_stops.lines IS
  'Linhas que param nesta parada. A interseção entre as linhas perto da origem e as linhas perto do destino É a resposta do corredor.';
COMMENT ON COLUMN transit_stops.feed_id IS
  'Origem do dado; a recarga é por feed (DELETE + INSERT do mesmo feed_id), para trocar uma fonte sem derrubar as outras.';

COMMIT;
