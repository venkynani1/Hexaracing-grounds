import { connectPostgres } from './client';
import { seedCatalogue } from './seed';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const handle = await connectPostgres(url, { migrate: true, max: 1 });
await seedCatalogue(handle.db);
await handle.close();
console.log('migrations applied and catalogue seeded');
