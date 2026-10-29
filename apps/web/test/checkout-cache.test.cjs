const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { QueryClient, QueryObserver } = require('@tanstack/react-query');

const source = fs.readFileSync(path.join(__dirname, '../components/operations/pos/checkout-cache.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
const loaded = { exports: {} };
new Function('exports', compiled.outputText)(loaded.exports);
const { prepareInvoicePrint } = loaded.exports;
const invoice = { id: 'invoice', tenantId: 'tenant', tenant: { id: 'tenant', rnc: 'DEMO' }, items: [], ncf: 'TEST', status: 'PAID' };
const makeClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

test('abrir impresión reutiliza la factura confirmada sin consultar nuevamente la API', async () => {
  const client = makeClient();
  prepareInvoicePrint(client, invoice);
  let requests = 0;
  const observer = new QueryObserver(client, {
    queryKey: ['invoice', invoice.id, invoice.tenantId], staleTime: 30_000,
    queryFn: async () => { requests++; return invoice; },
  });
  const unsubscribe = observer.subscribe(() => {});
  assert.equal(observer.getCurrentResult().data, invoice);
  assert.equal(observer.getCurrentResult().isFetching, false);
  assert.equal(requests, 0);
  unsubscribe();
  client.clear();
});

test('invalidar saldos no dispara recargas activas ni retrasa la impresión', () => {
  const client = makeClient();
  const key = ['cash-session-current', 'tenant'];
  client.setQueryData(key, { balance: 0 });
  let requests = 0;
  const observer = new QueryObserver(client, {
    queryKey: key, staleTime: Infinity,
    queryFn: () => { requests++; return new Promise(() => {}); },
  });
  const unsubscribe = observer.subscribe(() => {});
  assert.equal(prepareInvoicePrint(client, invoice), undefined);
  assert.equal(requests, 0);
  assert.equal(client.getQueryState(key).isInvalidated, true);
  unsubscribe();
  client.clear();
});

test('retira la orden cobrada, marca la cola pendiente de recarga y no toca otros negocios', () => {
  const client = makeClient();
  const key = ['sales-orders', 'tenant', 'OPEN', 'pos'];
  const otherKey = ['sales-orders', 'other-tenant', 'OPEN', 'pos'];
  client.setQueryData(key, [{ id: 'paid' }, { id: 'pending' }]);
  client.setQueryData(otherKey, [{ id: 'paid' }]);
  prepareInvoicePrint(client, invoice, 'paid');
  assert.deepEqual(client.getQueryData(key), [{ id: 'pending' }]);
  assert.equal(client.getQueryState(key).isInvalidated, true);
  assert.deepEqual(client.getQueryData(otherKey), [{ id: 'paid' }]);
  assert.equal(client.getQueryState(otherKey).isInvalidated, false);
  client.clear();
});

test('una respuesta antigua sin datos del emisor no se usa como factura completa', () => {
  const client = makeClient();
  prepareInvoicePrint(client, { ...invoice, tenant: undefined });
  assert.equal(client.getQueryData(['invoice', invoice.id, 'tenant']), undefined);
  client.clear();
});

test('una consulta anterior del borrador no reemplaza la factura cobrada', async () => {
  const client = makeClient();
  const key = ['invoice', invoice.id, invoice.tenantId];
  let finishOldRequest;
  const oldRequest = client.fetchQuery({
    queryKey: key,
    queryFn: () => new Promise((resolve) => { finishOldRequest = resolve; }),
  }).catch(() => undefined);
  prepareInvoicePrint(client, invoice);
  finishOldRequest({ ...invoice, status: 'DRAFT', ncf: null });
  await oldRequest;
  assert.equal(client.getQueryData(key), invoice);
  client.clear();
});
