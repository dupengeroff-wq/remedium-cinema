import {migrate, assertSchemaReady, migrationAllowed} from './migrations.js';
import pg from 'pg';

const url = process.env.DATABASE_URL;
let pool;
let initializing;

function getPool() {
  if (pool) return pool;
  if (!url) throw new Error('DATABASE_URL is missing');
  const connection = new URL(url);
  const testLocal = process.env.NODE_ENV === 'test' && ['localhost','127.0.0.1','[::1]'].includes(connection.hostname);
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

export function ready() {
  if (!initializing) initializing = assertSchemaReady(getPool).catch(error => { initializing = null; throw error; });
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

// This stage permits only an explicitly opted-in local test database.
export async function runMigrations() {
  if(!migrationAllowed(process.env))throw new Error('Migrations require an approved isolated local test database and explicit opt-in.');
  await migrate(getPool);
  initializing=null;
}
