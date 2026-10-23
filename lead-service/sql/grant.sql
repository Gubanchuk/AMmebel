-- Роль lead_service с минимальными правами для сервиса заявок.
--
-- Запускать от владельца таблицы leads (пользователь базы Directus) после
-- infra/setup-collections.py. Повторный запуск безопасен: права отзываются
-- и выдаются заново, пароль переустанавливается.
--
--   docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME" \
--     -v ON_ERROR_STOP=1 -v lead_password="$LEAD_DB_PASSWORD" \
--     < ../lead-service/sql/grant.sql
--
-- Что может роль: добавить заявку; прочитать колонки, нужные для RETURNING id
-- и очереди писем; поменять email_status. Лог согласия (ip, consent_version,
-- consent_at) она только пишет, прочитать не может. Удалять, читать другие
-- таблицы и менять что-то кроме статуса письма — нет.
-- Колонки ниже сверяет test/db.test.mjs с запросами src/db.mjs.

\if :{?lead_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'не задан пароль: psql -v lead_password=...'; END $$;
\endif

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lead_service') THEN
    CREATE ROLE lead_service;
  END IF;
END
$$;

ALTER ROLE lead_service WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
  NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD :'lead_password';
ALTER ROLE lead_service SET statement_timeout = '10s';

-- Сброс всего, что могло быть выдано раньше. Отзыв на уровне таблицы
-- снимает и права на отдельные колонки.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM lead_service;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM lead_service;
REVOKE ALL ON SCHEMA public FROM lead_service;

DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM lead_service', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO lead_service', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO lead_service;

-- external_id — номер заявки из лид-формы VK. ON CONFLICT (external_id) требует
-- права читать эту колонку (без него ошибка 42501, проверено 23.10.2026),
-- поэтому она есть и в SELECT. Персональных данных в ней нет.
GRANT INSERT (created_at, consent_at, email_status, type, company_inn, name, phone,
              city, need, need_extra, source_page, utm, ip, consent_version, external_id)
  ON TABLE leads TO lead_service;

GRANT SELECT (id, created_at, type, company_inn, name, phone, city, need, need_extra,
              source_page, utm, email_status, external_id)
  ON TABLE leads TO lead_service;

GRANT UPDATE (email_status) ON TABLE leads TO lead_service;

-- Последовательность id создал Directus; имя берём из самой колонки.
DO $$
DECLARE
  seq text := pg_get_serial_sequence('public.leads', 'id');
BEGIN
  IF seq IS NULL THEN
    RAISE EXCEPTION 'у leads.id нет последовательности';
  END IF;
  EXECUTE format('GRANT USAGE ON SEQUENCE %s TO lead_service', seq);
END
$$;

COMMIT;
