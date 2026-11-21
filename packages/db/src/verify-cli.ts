/**
 * db:verify — apply migrations + catalogue seed to DATABASE_URL, then prove the schema matches a fresh reference
 * migration (embedded PGlite, same migration files): tables, columns, constraints (incl. deferrable), indexes.
 * Prints no credentials: only the host class (pooler / direct), TLS mode and row counts.
 */
import { connectPglite, connectPostgres, type DbHandle } from './client';
import { seedCatalogue } from './seed';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const u = new URL(url);
console.log(`[verify] target: ${u.hostname.includes('-pooler.') ? 'Neon pooler' : u.hostname.endsWith('.neon.tech') ? 'Neon direct' : 'postgres'} host, sslmode=${u.searchParams.get('sslmode') ?? 'none'}, db=${u.pathname.slice(1)}`);

const Q = {
  tables: `select table_name as k from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`,
  columns: `select table_name||'.'||column_name||' '||data_type||' '||is_nullable as k from information_schema.columns where table_schema='public'`,
  constraints: `select rel.relname||'.'||c.conname||' '||c.contype::text||case when c.condeferrable then ' deferrable' else '' end||case when c.condeferred then ' deferred' else '' end as k
                from pg_constraint c join pg_class rel on rel.oid=c.conrelid join pg_namespace n on n.oid=rel.relnamespace where n.nspname='public' and c.contype <> 'n'`, // NOT NULL: compared via columns.is_nullable (PG17 lists it as a constraint, PG16 does not)
  indexes: `select tablename||'.'||indexname||' '||regexp_replace(indexdef,'^.* USING ','') as k from pg_indexes where schemaname='public'`,
};
async function catalog(h: DbHandle) {
  const out: Record<string, Set<string>> = {};
  for (const [name, sql] of Object.entries(Q)) {
    const r = (await h.db.execute(sql as never)) as unknown as { rows: { k: string }[] };
    out[name] = new Set(r.rows.map((x) => x.k));
  }
  return out;
}

const t0 = Date.now();
const target = await connectPostgres(url, { migrate: true, max: 2, migrationUrl: process.env.DATABASE_URL_UNPOOLED || undefined });
await seedCatalogue(target.db);
console.log(`[verify] migrations applied + catalogue seeded in ${Date.now() - t0} ms`);
const ref = await connectPglite(undefined, { migrate: true });
const [a, b] = [await catalog(target), await catalog(ref)];
let ok = true;
for (const k of Object.keys(Q)) {
  const missing = [...b[k]!].filter((x) => !a[k]!.has(x));
  const extra = [...a[k]!].filter((x) => !b[k]!.has(x));
  console.log(`[verify] ${k}: ${a[k]!.size} on target, ${b[k]!.size} expected, missing ${missing.length}, extra ${extra.length}`);
  for (const m of missing) console.log(`  MISSING ${m}`);
  for (const m of extra) console.log(`  EXTRA   ${m}`);
  if (missing.length) ok = false;
}
const tables = [...a.tables!].sort();
console.log(`[verify] tables: ${tables.join(', ')}`);
const counts: string[] = [];
for (const t of tables) {
  const r = (await target.db.execute(`select count(*)::int as n from "${t}"` as never)) as unknown as { rows: { n: number }[] };
  counts.push(`${t}=${r.rows[0]!.n}`);
}
console.log(`[verify] rows: ${counts.join(' ')}`);
await ref.close();
await target.close();
console.log(ok ? '[verify] PASS — schema matches the migrations' : '[verify] FAIL — schema differs');
process.exit(ok ? 0 : 1);
