CREATE user sprocketuser;
CREATE database sprocketdb;
ALTER USER sprocketuser WITH PASSWORD '';

GRANT ALL PRIVILEGES ON DATABASE sprocketdb to sprocketuser;
ALTER DATABASE sprocketdb OWNER TO sprocketuser;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO sprocketuser;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sprocketuser;
-- Ensure future tables are also granted:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO sprocketuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO sprocketuser;

% reset auto-increment after import
% SELECT setval('workouts_id_seq', (SELECT MAX(id) FROM workouts));