# Actions deployment

This fork deploys with `.github/workflows/deploy-production.yml`. The upstream
`deploy-cloudflare.yml` workflow must remain disabled in the repository Actions
settings. It is retained unchanged to simplify future upstream merges.

Pull requests build the frontend and bundle the Worker without credentials or
production deployment. A push to `main`, or a manual run on `main`, builds and
then deploys the existing Worker.

## Configuration

Repository variables: `CLOUDFLARE_ACCOUNT_ID`, `NAME`, `CUSTOM_DOMAIN`, `DOMAIN`
(JSON array), `ADMIN`, `D1_DATABASE_ID`, `KV_NAMESPACE_ID`, `R2_BUCKET_NAME`.

Repository secrets:

- `CLOUDFLARE_API_TOKEN`: account-scoped deployment token. Use the documented
  Edit Cloudflare Workers template, with D1 edit and access to the existing KV,
  R2, Workers AI, Worker scripts, custom domain and relevant zone.
- `BACKUP_ENCRYPTION_KEY`: 32 random bytes encoded as 64 hexadecimal characters.
  Keep a private offline copy; never commit it.
- `JWT_SECRET`: normally unnecessary for this migration. The pipeline reads the
  current plaintext Worker binding securely, masks it in logs, and preserves it
  with `keep_vars`. It refuses to replace the existing value.

Never put tokens, recovery keys or database exports in Git.

## Deployment and recovery

Before deploying, the pipeline verifies the existing Worker, domain, D1, KV and
R2 bindings, then exports D1 and captures current settings/deployment versions.
It encrypts the export with AES-256-GCM and uploads only the encrypted backup
artifact. The pipeline requires backup retention to succeed before deployment.
Plaintext backups and credentials are never uploaded as public artifacts.

After deployment, it bundles and executes the project's unchanged database
init module through authenticated D1/KV APIs, including the original Drizzle
settings-cache refresh. This avoids sending a credential in a public URL and
works when the site edge policy denies GitHub runner requests. It checks the
v3.4 schema and row counts. Initialization success alone is not accepted as
proof that all columns were migrated.

Homepage and public configuration checks are attempted separately. An HTML
403 from the Cloudflare edge is reported as inconclusive in the Actions step
summary, not as a successful public test. In that case, check reachability
from an allowed client. Other public HTTP/API failures still fail deployment.

Download the `encrypted-backup-<run-id>` artifact before it expires (30 days).
`decryptBackup` in `scripts/deploy-production.mjs` decrypts it using the saved
key. Restore database and Worker version together after a failed migration;
rolling back only Worker code does not undo a database schema change.

The current migration target is upstream tag `v3.4.0`, commit
`c0009ddae326197e22c44986b6537ca7d97e803a`. A merge commit connects the previous
fork history and that release without force-pushing or deleting old commits.
For future upgrades, merge a reviewed upstream release into a branch and open
a PR. Keep `deploy-production.yml` and the scripts; do not re-enable the
upstream deployment workflow or the previous Cloudflare Git build integration.

The v3.4 release runs its scheduled maintenance hourly. Existing Cloudflare
email-sending bindings are retained; migration does not enable a new sending
provider. Existing Email Routing rules remain attached to the same Worker.
