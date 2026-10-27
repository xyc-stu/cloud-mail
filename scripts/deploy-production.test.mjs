import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptBackup, decryptBackup, verifyBindings, activeDeploymentSettings } from './deploy-production.mjs';

test('production bindings come from the deployed version, not an unbound latest upload', async () => {
  const bindings = [{ name: 'db', type: 'd1', database_id: 'production-db' }];
  const request = async path => {
    if (path.endsWith('/deployments')) return { deployments: [{ versions: [{ version_id: 'active', percentage: 100 }] }] };
    if (path.endsWith('/versions/active')) return { resources: { bindings, script_runtime: { compatibility_date: '2025-06-04' } } };
    if (path.endsWith('/settings')) return { bindings: [], compatibility_date: '2026-10-27' };
    throw new Error('Unexpected request');
  };
  const result = await activeDeploymentSettings(request);
  assert.deepEqual(result.settings.bindings, bindings);
  assert.equal(result.settings.compatibility_date, '2025-06-04');
  assert.equal(result.versionId, 'active');
});

test('backup encryption detects tampering and wrong recovery keys', () => {
  const key = 'ab'.repeat(32);
  const payload = { sql: 'private email contents', jwt: 'private jwt' };
  const encrypted = encryptBackup(payload, key);
  assert(!JSON.stringify(encrypted).includes(payload.jwt));
  assert.deepEqual(decryptBackup(encrypted, key), payload);
  assert.throws(() => decryptBackup(encrypted, 'cd'.repeat(32)));
  assert.throws(() => decryptBackup({ ...encrypted, tag: '00'.repeat(16) }, key));
});

test('deployment refuses replacement database, missing R2, or unknown bindings', () => {
  const bindings = [{ name: 'db', type: 'd1', id: 'original-db' }, { name: 'kv', type: 'kv_namespace', namespace_id: 'original-kv' }, { name: 'r2', type: 'r2_bucket', bucket_name: 'original-bucket' }];
  const expected = { D1_DATABASE_ID: 'original-db', KV_NAMESPACE_ID: 'original-kv', R2_BUCKET_NAME: 'original-bucket' };
  verifyBindings(bindings, expected);
  assert.throws(() => verifyBindings(bindings, { ...expected, D1_DATABASE_ID: 'new-db' }));
  assert.throws(() => verifyBindings(bindings.slice(0, 2), expected));
  assert.throws(() => verifyBindings([...bindings, { name: 'queue', type: 'queue' }], expected));
});
