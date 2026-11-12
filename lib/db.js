import fs from 'node:fs/promises';
import pg from 'pg';

const migrationFiles = ['001_accounts.sql'];
const url = process.env.DATABASE_URL;
let pool;
let initializing;

function getPool() {
  if (pool) return pool;
  if (!url) throw new Error('DATABASE_URL is missing');
  const connection = new URL(url);
  const testLocal = process.env.NODE_ENV === 'test' && ['localhost','127.0.0.1'].includes(connection.hostname);
  for (const option of ['sslmode','sslcert','sslkey','sslrootcert']) connection.searchParams.delete(option);
  pool = new pg.Pool({
    connectionString: connection.toString(),
    ssl: testLocal ? false : {rejectUnauthorized: true},
    enableChannelBinding: !testLocal,
    max: 5,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 8000,
    statement_timeout: 10000,
    query_timeout: 12000,
    keepAlive: true,
    application_name: 'remedium-cinema'
  });
  pool.on('error', error => console.warn('PostgreSQL connection:', error.code || error.name));
  return pool;
}

async function migrate() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(582031734)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of migrationFiles) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount) continue;
      await client.query(await fs.readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)',[name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export function ready() {
  if (!initializing) initializing = migrate().catch(error => { initializing = null; throw error; });
  return initializing;
}

export async function query(text, params) {
  await ready();
  return getPool().query(text,params);
}

export async function transaction(work) {
  await ready();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function close() { if (pool) await pool.end(); }
