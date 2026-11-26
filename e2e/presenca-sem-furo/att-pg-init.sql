-- Init do Postgres descartavel (spec 077 F1). Executado UMA vez pelo superusuario do container.
-- Senhas efemeras vem do ambiente (docker exec -e OWNER_PW / SA_PW) via \getenv (psql >= 15).
\getenv owner_pw OWNER_PW
\getenv sa_pw SA_PW

CREATE ROLE enlite_owner LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS PASSWORD :'owner_pw';
CREATE DATABASE attendance_local OWNER enlite_owner;
CREATE ROLE attendance_sa_test LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'sa_pw';
GRANT CONNECT ON DATABASE attendance_local TO attendance_sa_test;
