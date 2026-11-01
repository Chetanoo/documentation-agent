import pg from 'pg';
import { DATABASE_URL, EMBEDDING } from '../src/config.js';
import { schemaSql } from '../src/db/schema.js';

// Usage: npm run db:migrate            create tables if missing
//        npm run db:migrate -- --reset drop and recreate (needed after changing EMBEDDING.dims)
const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  if (process.argv.includes('--reset')) {
    await client.query('drop table if exists chunks');
    console.log('dropped chunks');
  }
  await client.query(schemaSql(EMBEDDING.dims));
  const { rows } = await client.query<{ v: string }>(
    "select extversion as v from pg_extension where extname = 'vector'",
  );
  console.log(`schema ready (pgvector ${rows[0]?.v}, vector(${EMBEDDING.dims}))`);
} finally {
  await client.end();
}
