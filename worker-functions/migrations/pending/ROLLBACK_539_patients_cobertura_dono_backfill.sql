-- ROLLBACK_539_patients_cobertura_dono_backfill.sql — par de rollback da migration 539 (spec 058 Parte A).
-- NO-OP DE PROPÓSITO: o backfill só escreveu onde o dono era NULL, e depois dele o dono passa a receber escrita da aplicação — não há como
-- separar o que a 539 copiou do que um operador digitou. Desfazer apagaria dado do dono. As colunas legadas continuam intactas
-- (snapshot) até o P2(A); se for preciso refazer, é um UPDATE novo e consciente, por task_id nomeado.
SELECT 1;
