-- Database-per-service (plan §5.1, §23): one database + one owner role per service.
-- Services connect only to their own database. Dev-only passwords; production uses secrets.

CREATE ROLE identity_svc LOGIN PASSWORD 'identity_svc';
CREATE DATABASE identity OWNER identity_svc;

CREATE ROLE users_svc LOGIN PASSWORD 'users_svc';
CREATE DATABASE users OWNER users_svc;

CREATE ROLE battle_svc LOGIN PASSWORD 'battle_svc';
CREATE DATABASE battle OWNER battle_svc;

CREATE ROLE problem_svc LOGIN PASSWORD 'problem_svc';
CREATE DATABASE problem OWNER problem_svc;

CREATE ROLE judge_svc LOGIN PASSWORD 'judge_svc';
CREATE DATABASE judge OWNER judge_svc;

CREATE ROLE rating_svc LOGIN PASSWORD 'rating_svc';
CREATE DATABASE rating OWNER rating_svc;

CREATE ROLE notification_svc LOGIN PASSWORD 'notification_svc';
CREATE DATABASE notification OWNER notification_svc;

CREATE ROLE ai_svc LOGIN PASSWORD 'ai_svc';
CREATE DATABASE ai OWNER ai_svc;

CREATE ROLE template_svc LOGIN PASSWORD 'template_svc';
CREATE DATABASE template OWNER template_svc;

-- Extensions need superuser; create them up front in the databases that use them.
\connect identity
CREATE EXTENSION IF NOT EXISTS citext;
\connect users
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
\connect ai
CREATE EXTENSION IF NOT EXISTS vector;
