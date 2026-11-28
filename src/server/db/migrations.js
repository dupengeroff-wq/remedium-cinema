import fs from 'node:fs/promises';

export const migrationFiles = Object.freeze([
  '001_accounts.sql',
  '002_room_chat_and_profile_visibility.sql',
  '003_watch_movie_details.sql',
  '004_watch_room_covers.sql',
  '005_profile_theme.sql',
  '006_personal_watch_history.sql',
  '007_profile_theme_options.sql',
  '008_cinema_chat_and_themes.sql',
  '009_shared_watch_history.sql',
  '010_zero_two.sql',
  '011_default_profile_theme.sql',
  '012_film_ratings.sql'
]);
// HTTP startup/readiness must never apply DDL implicitly.
export async function assertSchemaReady(getPool) {
  let result;
  try { result=await getPool().query('SELECT name FROM schema_migrations'); }
  catch(error) {
    if(error.code==='42P01')throw new Error('Schema is not initialized; run the approved migration procedure.');
    throw error;
  }
  const applied=new Set(result.rows.map(row=>row.name));
  const missing=migrationFiles.filter(name=>!applied.has(name));
  if(missing.length)throw new Error('Schema migrations pending: '+missing.join(', '));
}
export function migrationAllowed(env) {
  if(env.NODE_ENV!=='test' || env.REMEDIUM_RUN_MIGRATIONS!=='1')return false;
  try {
    const url=new URL(env.DATABASE_URL);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  } catch {return false;}
}
export async function migrate(getPool) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(582031734)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const name of migrationFiles) {
      if ((await client.query('SELECT 1 FROM schema_migrations WHERE name=$1',[name])).rowCount) continue;
      await client.query(await fs.readFile(new URL('../../../migrations/' + name, import.meta.url), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)',[name]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

