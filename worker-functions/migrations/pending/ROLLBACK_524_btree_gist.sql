-- Volta da 524. RESTRICT (padrão): falha se algum EXCLUDE ainda usa a extensão — rodar DEPOIS dos rollbacks 525 e 527.
DROP EXTENSION IF EXISTS btree_gist;
