const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
(async () => {
  for (const method of ['getSummary', 'getProductSales']) {
    const before = JSON.parse(
      await fs.readFile('../../.tmp/dashboard-baseline-' + method + '.json', 'utf8'),
    );
    const after = JSON.parse(
      await fs.readFile('../../.tmp/dashboard-optimized-' + method + '.json', 'utf8'),
    );
    delete before.generatedAt;
    delete after.generatedAt;
    assert.deepEqual(
      after,
      before,
      method + ': resultados anteriores y optimizados deben coincidir',
    );
    console.log('OK parity: ' + method);
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
