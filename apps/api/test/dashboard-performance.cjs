require('reflect-metadata');
const { PrismaClient } = require('@qorvex/database');
const { DashboardService } = require('../dist/modules/dashboard/dashboard.service');
const fs = require('node:fs/promises');
const db = new PrismaClient({ log: [{ level: 'query', emit: 'event' }] });
let queries = 0;
db.$on('query', () => queries++);
(async () => {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { slug: 'hotel-ancla' } });
  const service = new DashboardService(db);
  const baselineFile = process.argv[2];
  for (const method of ['getSummary', 'getProductSales']) {
    queries = 0;
    const start = performance.now();
    const result = await service[method](tenant.id);
    console.log(
      JSON.stringify({ method, milliseconds: Math.round(performance.now() - start), queries }),
    );
    if (baselineFile)
      await fs.writeFile(baselineFile + '-' + method + '.json', JSON.stringify(result));
  }
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
