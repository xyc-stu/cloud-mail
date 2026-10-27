import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const check = (condition, message) => { if (!condition) throw new Error(message); };

// Implements the D1 methods used by upstream init and Drizzle using the same
// authenticated REST API. raw() preserves SQL column order for Drizzle mapping.
export function restD1(api, base) {
  function prepare(sql, params = []) {
    const query = { sql, params };
    async function all() {
      const results = await api(`${base}/query`, query);
      check(results.length === 1 && results[0].success, 'D1 statement failed');
      return results[0];
    }
    return {
      query,
      bind: (...values) => prepare(sql, values),
      all, run: all,
      async first(column) { const row = (await all()).results[0]; return row ? (column ? row[column] : row) : null; },
      async raw(options) {
        const results = await api(`${base}/raw`, query);
        check(results.length === 1 && results[0].success, 'D1 raw statement failed');
        const { columns, rows } = results[0].results;
        return options?.columnNames ? [columns, ...rows] : rows;
      }
    };
  }
  return {
    prepare,
    async batch(statements) {
      const results = await api(`${base}/query`, { batch: statements.map(x => x.query) });
      check(results.length === statements.length && results.every(x => x.success), 'D1 batch failed');
      return results;
    }
  };
}

export async function runProjectInit({ api, account, databaseId, namespaceId, jwt }) {
  const workerRequire = createRequire(resolve('mail-worker/package.json'));
  const wranglerRequire = createRequire(workerRequire.resolve('wrangler/package.json'));
  const { build } = wranglerRequire('esbuild');
  const outfile = resolve('mail-worker/.actions-init.cjs');
  await build({ entryPoints: ['mail-worker/src/init/init.js'], outfile, bundle: true, platform: 'node', target: 'node24', format: 'cjs', logLevel: 'silent' });
  const { dbInit } = createRequire(import.meta.url)(outfile);
  const db = restD1(api, `/accounts/${account}/d1/database/${databaseId}`);
  let cacheWritten = false;
  const kv = {
    async put(key, value) {
      await api(`/accounts/${account}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`, value, { method: 'PUT', raw: true, contentType: 'application/octet-stream' });
      const setting = JSON.parse(value);
      check(['syncDelete', 'webhookUrl', 'autoCleanDays'].every(x => x in setting), 'Refreshed settings cache is incomplete');
      cacheWritten = true;
    }
  };
  const context = { env: { db, kv, jwt_secret: jwt, orm_log: false }, req: { param: () => jwt }, text: value => value, set() {} };
  // Historical migrations catch duplicate-column errors. Do not publish SQL or
  // existing data in CI logs; the schema/cache checks below establish success.
  const warn = console.warn;
  let warnings = 0;
  console.warn = () => warnings++;
  let result;
  try { result = await dbInit.init(context); } finally { console.warn = warn; }
  check(result === 'success' && cacheWritten, 'Project database/cache initialization did not complete');
  console.log(`Upstream database init and settings cache refresh completed through Cloudflare API (${warnings} historical migration warnings).`);
}
