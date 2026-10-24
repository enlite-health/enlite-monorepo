-- Volta da 526. RESTRICT (padrão): falha se algum EXCLUDE ainda usa a extensão — rodar DEPOIS dos rollbacks 527 e 529.
DROP EXTENSION IF EXISTS btree_gist;
