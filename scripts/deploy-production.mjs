import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const name = process.env.NAME;
const workerPath = `/accounts/${account}/workers/scripts/${name}`;
const configFile = 'mail-worker/.actions-wrangler.json';
const runtimeFile = 'mail-worker/.actions-runtime.json';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const required = key => { check(process.env[key], `Missing configuration: ${key}`); return process.env[key]; };

function mask(value) {
  if (process.env.GITHUB_ACTIONS && value) console.log(`::add-mask::${String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
}

async function api(path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000)
  });
  const data = await response.json();
  check(response.ok && data.success, `Cloudflare API failed (${response.status}) at ${path.split('?')[0]}; codes: ${(data.errors || []).map(x => x.code).join(',')}`);
  return data.result;
}

export async function activeDeploymentSettings(request = api) {
  const deployments = await request(`${workerPath}/deployments`);
  const current = deployments.deployments?.[0];
  check(current?.versions?.length === 1 && current.versions[0].percentage === 100, 'Expected one production version serving all traffic');
  const versionId = current.versions[0].version_id;
  const version = await request(`${workerPath}/versions/${versionId}`);
  const latest = await request(`${workerPath}/settings`);
  // /settings can describe an undeployed upload. Bindings must come from the
  // version actually serving traffic, including after a rollback.
  const runtime = version.resources?.script_runtime;
  check(runtime?.compatibility_date && Array.isArray(version.resources?.bindings), 'Production version metadata is incomplete');
  return { versionId, deployments, version, settings: {
    ...latest, compatibility_date: runtime.compatibility_date,
    compatibility_flags: runtime.compatibility_flags || [], bindings: version.resources.bindings
  } };
}

export function verifyBindings(bindings, expected = process.env) {
  const get = key => bindings.find(x => x.name === key);
  check(get('db')?.type === 'd1' && (get('db').id || get('db').database_id) === expected.D1_DATABASE_ID, `D1 binding mismatch; refusing deployment (actual: ${JSON.stringify(get('db'))}; expected ID: ${expected.D1_DATABASE_ID})`);
  check(get('kv')?.type === 'kv_namespace' && get('kv').namespace_id === expected.KV_NAMESPACE_ID, 'KV binding mismatch; refusing deployment');
  check(get('r2')?.type === 'r2_bucket' && get('r2').bucket_name === expected.R2_BUCKET_NAME, 'R2 binding mismatch; refusing deployment');
  check(bindings.every(x => ['plain_text', 'json', 'secret_text', 'd1', 'kv_namespace', 'r2_bucket', 'ai', 'assets', 'send_email'].includes(x.type)), 'Unexpected binding type; review configuration');
}

export function encryptBackup(payload, keyHex) {
  check(/^[a-f0-9]{64}$/i.test(keyHex || ''), 'BACKUP_ENCRYPTION_KEY must be 32 bytes encoded as hexadecimal');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { format: 'cloud-mail-backup-v1', iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
}

export function decryptBackup(envelope, keyHex) {
  check(envelope.format === 'cloud-mail-backup-v1', 'Unsupported backup format');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(envelope.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
}

async function tableCounts() {
  const result = await api(`/accounts/${account}/d1/database/${required('D1_DATABASE_ID')}/query`, {
    sql: "SELECT 'email' AS name,COUNT(*) AS rows FROM email UNION ALL SELECT 'user',COUNT(*) FROM user UNION ALL SELECT 'attachments',COUNT(*) FROM attachments;"
  });
  check(result.every(x => x.success), 'D1 count query failed');
  return Object.fromEntries(result[0].results.map(x => [x.name, x.rows]));
}

async function exportDatabase() {
  let bookmark;
  for (let i = 0; i < 60; i++) {
    const result = await api(`/accounts/${account}/d1/database/${required('D1_DATABASE_ID')}/export`, { output_format: 'polling', ...(bookmark ? { current_bookmark: bookmark } : {}) });
    check(result.success !== false && result.status !== 'error', 'Database export failed');
    if (result.status === 'complete') {
      const url = result.result?.signed_url;
      check(url?.startsWith('https://'), 'Missing backup download URL');
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      check(response.ok, 'Could not download backup');
      const sql = await response.text();
      check(sql.includes('CREATE TABLE') && sql.includes('INSERT INTO'), 'Database backup is incomplete');
      return { sql, bookmark: result.at_bookmark, sha256: createHash('sha256').update(sql).digest('hex') };
    }
    bookmark = result.at_bookmark;
    check(bookmark, 'Missing export polling bookmark');
    await pause(1000);
  }
  throw new Error('Backup timed out; deployment was not started');
}

async function prepare() {
  ['CLOUDFLARE_ACCOUNT_ID', 'NAME', 'CUSTOM_DOMAIN', 'DOMAIN', 'ADMIN', 'D1_DATABASE_ID', 'KV_NAMESPACE_ID', 'R2_BUCKET_NAME', 'BACKUP_ENCRYPTION_KEY'].forEach(required);
  check(/^[a-z0-9-]+$/.test(name) && /^[a-z0-9.-]+$/i.test(process.env.CUSTOM_DOMAIN), 'Invalid Worker name or website hostname');
  const active = await activeDeploymentSettings();
  const settings = active.settings;
  verifyBindings(settings.bindings);
  const value = key => { const b = settings.bindings.find(x => x.name === key); return b?.type === 'json' ? b.json : b?.text; };
  const jwt = process.env.JWT_SECRET || value('jwt_secret');
  check(jwt && jwt === value('jwt_secret'), 'Existing JWT secret must be preserved');
  mask(jwt);
  const permissionErrors = [];
  for (const [path, body] of [
    [`/accounts/${account}/workers/domains`],
    [`/accounts/${account}/d1/database/${process.env.D1_DATABASE_ID}`],
    [`/accounts/${account}/d1/database/${process.env.D1_DATABASE_ID}/query`, { sql: 'SELECT 1;' }],
    [`${workerPath}/schedules`]
  ]) {
    try { await api(path, body); } catch (error) { permissionErrors.push(error.message); }
  }
  check(permissionErrors.length === 0, permissionErrors.join('\n'));
  check(value('admin') === process.env.ADMIN, 'Administrator differs from existing deployment');
  const domains = JSON.parse(process.env.DOMAIN);
  const oldDomains = typeof value('domain') === 'string' ? JSON.parse(value('domain')) : value('domain');
  check(Array.isArray(domains) && JSON.stringify(domains) === JSON.stringify(oldDomains), 'Email domains differ from existing deployment');
  const domain = (await api(`/accounts/${account}/workers/domains`)).find(x => x.hostname === process.env.CUSTOM_DOMAIN && x.service === name);
  check(domain, 'Website domain is not attached to existing Worker');
  const db = await api(`/accounts/${account}/d1/database/${process.env.D1_DATABASE_ID}`);
  const deployments = active.deployments;
  const schedules = await api(`${workerPath}/schedules`);
  const beforeCounts = await tableCounts();
  const backup = await exportDatabase();
  const encrypted = encryptBackup({ ...backup, settings, deployments, schedules, beforeCounts, createdAt: new Date().toISOString(), commit: process.env.GITHUB_SHA }, process.env.BACKUP_ENCRYPTION_KEY);
  await mkdir('.deployment-backup', { recursive: true });
  await writeFile('.deployment-backup/database.enc.json', JSON.stringify(encrypted));
  const vars = Object.fromEntries(settings.bindings.filter(x => ['plain_text', 'json'].includes(x.type)).map(x => [x.name, x.type === 'json' ? x.json : x.text]));
  delete vars.jwt_secret;
  const sendEmail = settings.bindings.filter(x => x.type === 'send_email').map(({ name, destination_address, allowed_destination_addresses }) => ({ name, ...(destination_address ? { destination_address } : {}), ...(allowed_destination_addresses ? { allowed_destination_addresses } : {}) }));
  const config = {
    name, main: 'src/index.js', compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags || [], keep_vars: true,
    observability: { enabled: settings.observability?.enabled ?? true }, vars,
    routes: [{ pattern: process.env.CUSTOM_DOMAIN, custom_domain: true, zone_id: domain.zone_id }],
    d1_databases: [{ binding: 'db', database_name: db.name, database_id: process.env.D1_DATABASE_ID }],
    kv_namespaces: [{ binding: 'kv', id: process.env.KV_NAMESPACE_ID }],
    r2_buckets: [{ binding: 'r2', bucket_name: process.env.R2_BUCKET_NAME }], ai: { binding: 'ai' },
    assets: { binding: 'assets', directory: './dist', not_found_handling: 'single-page-application', run_worker_first: true },
    triggers: { crons: ['0 * * * *'] }, ...(sendEmail.length ? { send_email: sendEmail } : {})
  };
  await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  await writeFile(runtimeFile, JSON.stringify({ jwt, beforeCounts, versionId: active.versionId }), { mode: 0o600 });
  console.log('Existing resources verified; encrypted recovery backup created. No deployment yet.');
}

async function deploy() {
  const runtime = JSON.parse(await readFile(runtimeFile, 'utf8'));
  mask(runtime.jwt);
  check((await activeDeploymentSettings()).versionId === runtime.versionId, 'Production changed after backup; refusing concurrent deployment');
  const child = spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['exec', 'wrangler', 'deploy', '--config', '.actions-wrangler.json'], { cwd: 'mail-worker', stdio: 'inherit', env: process.env });
  check(!child.error && child.status === 0, 'Worker deployment failed; database initialization was not attempted');
  const after = (await activeDeploymentSettings()).settings;
  verifyBindings(after.bindings);
  check(after.bindings.find(x => x.name === 'jwt_secret')?.text === runtime.jwt, 'JWT secret changed during deployment');
  let initialized = false;
  // Never redirect the initialization URL, which contains a credential.
  for (let i = 0; i < 12; i++) {
    await pause(5000);
    try {
      const response = await fetch(`https://${process.env.CUSTOM_DOMAIN}/api/init/${encodeURIComponent(runtime.jwt)}`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(90_000) });
      const text = (await response.text()).trim();
      if (response.ok && text === 'success') { initialized = true; break; }
      let code;
      try { code = JSON.parse(text).code; } catch { /* No response text in logs. */ }
      console.log(`Initialization attempt ${i + 1}: HTTP ${response.status}, content-type ${response.headers.get('content-type')}, API code ${typeof code === 'number' ? code : 'none'}`);
    } catch (error) { console.log(`Initialization attempt ${i + 1}: ${error.name}; credential URL suppressed`); }
  }
  check(initialized, 'Database initialization failed; inspect recovery backup before retrying');
  const columns = await api(`/accounts/${account}/d1/database/${process.env.D1_DATABASE_ID}/query`, { sql: "PRAGMA table_info(email); PRAGMA table_info(setting);" });
  check(columns.every(x => x.success), 'Schema query failed');
  check(columns[0].results.some(x => x.name === 'sender_email'), 'v3.4.0 email migration did not complete');
  for (const column of ['sync_delete', 'github_client_id', 'auto_clean_days', 'webhook_url']) check(columns[1].results.some(x => x.name === column), `Missing migrated column: ${column}`);
  const counts = await tableCounts();
  for (const [table, previous] of Object.entries(runtime.beforeCounts)) check(counts[table] >= previous, `Row count decreased: ${table}`);
  const homepage = await fetch(`https://${process.env.CUSTOM_DOMAIN}/`, { signal: AbortSignal.timeout(30_000) });
  check(homepage.ok && (await homepage.text()).includes('<html'), 'Homepage verification failed');
  const health = await fetch(`https://${process.env.CUSTOM_DOMAIN}/api/setting/websiteConfig`, { signal: AbortSignal.timeout(30_000) });
  const data = await health.json();
  check(health.ok && data.code === 200, 'Website configuration API verification failed');
  console.log('Deployment, migration, original bindings and row counts verified.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === 'prepare') await prepare();
    else if (process.argv[2] === 'deploy') await deploy();
    else throw new Error('Expected prepare or deploy');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
