# CAD Viewer PostgreSQL Cutover Notes

Date: 2026-07-13

## Summary

The CAD Viewer core operational records have been moved from JSON-primary storage
to PostgreSQL-primary storage on the same Azure Linux VM as the CAD Viewer
service.

PostgreSQL now stores:

- Viewer link records from `data/viewer-links.json`
- HubSpot workflow access records from `data/hubspot-project-access.json`

The following remain file-based by design:

- CAD, GLB, EASM, STEP, and other model files
- EASM catalog cache under `data/easm-catalog-cache/`
- Shared project catalog at `data/shared-project-catalog.json`
- Webhook and access event JSONL logs
- Mock and static JSON files

The cutover was done in a stabilization mode:

- PostgreSQL is the primary store.
- JSON fallback remains enabled.
- JSON backup writes remain enabled.
- Existing JSON files were preserved.
- Existing public endpoint paths were preserved.
- Existing public model IDs, query hashes, project numbers, and access keys were
  preserved.

## Architecture

PostgreSQL runs locally on the CAD Viewer VM.

Connection pattern:

```text
postgresql://cad_viewer_app:<password>@127.0.0.1:5432/cad_viewer
```

Important security decisions:

- PostgreSQL is local-only.
- Port `5432` was not opened in Azure NSG, UFW, iptables, or any external
  firewall.
- PostgreSQL listens only on localhost / local socket.
- The application uses a dedicated role, `cad_viewer_app`.
- The application does not use the `postgres` superuser.
- The database credential is stored outside the repository.

Runtime environment file:

```text
/etc/cad-viewer/cad-viewer-db.env
```

Systemd drop-in:

```text
/etc/systemd/system/cad-viewer.service.d/database.conf
```

Current production flags:

```text
DATABASE_URL=<local PostgreSQL connection string>
DATABASE_SSL=false
JSON_FALLBACK_ENABLED=true
JSON_BACKUP_WRITE_ENABLED=true
```

## Database Schema

The existing `viewer_links` table now preserves public-facing model IDs with a
separate stable string column:

```text
viewer_links.public_model_id
```

This prevents endpoint IDs such as the following from being silently replaced by
UUIDs:

```text
/api/models/:modelId/glb
/api/models/:modelId/catalog
```

The workflow access table was added:

```text
hubspot_project_access
```

It stores HubSpot workflow/project access fields including:

- Project number
- Access key
- HubSpot object ID
- HubSpot object type ID
- Serial number name
- Mapped model ID
- Query hash
- Model file name
- Viewer URL
- Mapped-model status
- First seen timestamp
- Last seen timestamp
- Last webhook event ID
- Active status
- Created and updated timestamps

Key lookup paths are indexed:

- Viewer link lookup by query hash
- Viewer link lookup by public model ID
- Viewer link lookup by project number
- Viewer link lookup by HubSpot access key
- Workflow access lookup by access key
- Workflow access lookup by HubSpot object ID
- Workflow access lookup by project number
- Workflow access lookup by query hash

## Migration Commands

Schema migration:

```bash
DATABASE_URL='<local connection string>' DATABASE_SSL=false npm run db:migrate
```

JSON import:

```bash
DATABASE_URL='<local connection string>' DATABASE_SSL=false npm run db:import-json
```

The import script is repeatable and uses upsert behavior. It does not delete the
source JSON files.

## Import Result

Source files:

```text
data/viewer-links.json
data/hubspot-project-access.json
```

Expected and validated counts:

```text
viewer links: 14
active viewer links: 14
workflow access records: 4
active workflow access records: 4
workflow records with mapped models: 3
```

Import result:

```text
viewer links inserted: 14
viewer links updated: 0
viewer links skipped: 0
viewer links failed: 0

workflow access records inserted: 4
workflow access records updated: 0
workflow access records skipped: 0
workflow access records failed: 0
```

Validation checks passed for:

- Total viewer-link count
- Active viewer-link count
- Workflow access record count
- Mapped-model count
- Lookup by public model ID
- Lookup by query hash
- Lookup by `c3_access_key`
- Lookup by project number
- Lookup by HubSpot object ID

## Current Endpoint Behavior

The public API paths did not change.

Important endpoints still supported:

```text
GET /cad-viewer/api/health
GET /cad-viewer/api/viewer-context?q=<queryHash>
GET /cad-viewer/api/viewer-context?q=test
GET /cad-viewer/api/viewer-context?q=test-bun
GET /cad-viewer/api/project-viewer-context?q=<projectId>
GET /cad-viewer/api/viewer-links
GET /cad-viewer/api/hubspot/model-summary?q=<c3_access_key>
GET /cad-viewer/api/hubspot/webhook-status
GET /cad-viewer/api/admin/viewer-links
GET /cad-viewer/api/models/:modelId/glb
GET /cad-viewer/api/models/:modelId/catalog
POST /cad-viewer/api/hubspot/webhook
```

Behavior preserved:

- Existing public viewer URLs continue resolving.
- Existing query hashes continue resolving.
- Existing `c3_access_key` values continue resolving.
- Existing project IDs and model IDs continue working.
- HubSpot workflow webhook behavior is preserved.
- Viewer context and model summary response formats are preserved.
- Admin viewer-link endpoint behavior is preserved.

## Health Endpoint

The health endpoint now reports storage state without exposing credentials:

```text
GET /cad-viewer/api/health
```

It reports:

- Whether PostgreSQL is configured
- Whether PostgreSQL is reachable
- Active storage mode
- Whether JSON fallback is enabled
- Whether JSON backup writes are enabled

Expected stabilization-mode state:

```json
{
  "database": {
    "configured": true,
    "connected": true
  },
  "storage": {
    "mode": "postgres",
    "jsonFallbackEnabled": true,
    "jsonBackupWriteEnabled": true
  }
}
```

## Write Path

HubSpot workflow webhook writes now use PostgreSQL as the primary store.

Temporary stabilization behavior:

- Primary write target: PostgreSQL
- Backup write target: JSON, when `JSON_BACKUP_WRITE_ENABLED=true`
- Duplicate delivery remains idempotent
- JSON backup writes do not create duplicate workflow records

The safe test webhook replay confirmed:

- The webhook returned `202 Accepted`
- PostgreSQL was updated
- JSON backup was updated
- Duplicate delivery did not create duplicate records
- Existing API response shape remained compatible

## Fallback Behavior

When PostgreSQL is configured but temporarily unavailable:

- `/api/health` reports database connectivity failure clearly
- Existing viewer records can still resolve through JSON fallback
- JSON fallback is only active when `JSON_FALLBACK_ENABLED=true`
- PostgreSQL can recover without data loss after connectivity returns

This fallback behavior was tested by briefly stopping PostgreSQL, verifying an
existing viewer context still loaded, then restarting PostgreSQL and confirming
health returned to connected.

## Backups

Timestamped JSON backups were created before the cutover:

```text
data/backups/2026-07-13T19-49-40-805Z/viewer-links.json
data/backups/2026-07-13T19-49-40-805Z/hubspot-project-access.json
```

These backups remain local runtime data and are intentionally not committed to
git.

## Deployment State

The deployed CAD Viewer service is running through systemd:

```text
cad-viewer.service
```

The service was restarted after verification.

Public viewer URL:

```text
https://20.40.253.16/cad-viewer/
```

Smoke tests returned success for:

- Health
- Test viewer context
- Test Bun viewer context
- Viewer links
- Project viewer context
- HubSpot model summary
- Webhook status
- Admin viewer links
- One GLB endpoint
- One model catalog endpoint

## Rollback Procedure

If production validation fails, rollback is intentionally simple:

1. Remove or disable the systemd database drop-in:

   ```text
   /etc/systemd/system/cad-viewer.service.d/database.conf
   ```

2. Reload systemd:

   ```bash
   systemctl daemon-reload
   ```

3. Restart only the CAD Viewer service:

   ```bash
   systemctl restart cad-viewer
   ```

4. Verify health and known viewer URLs.

5. Leave PostgreSQL and imported data intact.

Do not delete the database as part of rollback. Keeping the imported data allows
safe investigation and retry.

## Operational Notes

Do not commit the following:

- `/etc/cad-viewer/cad-viewer-db.env`
- Runtime `data/`
- JSON backups
- JSONL webhook/access logs
- Local systemd unit files containing environment-specific secrets
- `node_modules/`

The repository `.gitignore` excludes local runtime data and service files.

One existing security cleanup remains:

- Some non-database service secrets are still configured inline in the local
  systemd unit/drop-ins.
- They should be moved into protected root-owned environment files in a future
  cleanup.
- This was not changed during the PostgreSQL cutover to avoid expanding the
  scope.

## Recommended Stabilization Plan

Keep this mode temporarily:

```text
PostgreSQL primary
JSON fallback enabled
JSON backup writes enabled
```

Recommended next steps:

1. Monitor health and endpoint behavior for a few business days.
2. Check logs for JSON fallback usage.
3. Confirm HubSpot workflow writes continue updating PostgreSQL correctly.
4. Confirm dashboard/admin views continue resolving records from PostgreSQL.
5. Disable JSON backup writes after confidence in PostgreSQL write stability.
6. Disable JSON fallback after confirming no missing PostgreSQL records and no
   fallback usage.

Suggested sequence:

```text
First: disable JSON backup writes
Later: disable JSON fallback
Last: archive JSON files, only after a separate approval
```

Do not delete or archive JSON source files until explicitly approved.

## AIM Readiness

The data layer is now better prepared for future AIM endpoints because the
viewer-link and workflow-access records are queryable relational records.

Recommended future AIM endpoint layer:

- Add AIM-specific routes as a separate API layer.
- Reuse the viewer-link and workflow-access repositories.
- Keep AIM optional and out of the CAD Viewer runtime dependency path.
- Do not add AIM business rules directly into existing viewer endpoints.
- Keep public CAD Viewer endpoint behavior stable.

Potential future AIM queries:

- Project exists
- Project has CAD model
- Project has C3 access
- Project is mapped to a catalog/model
- Project is quote-ready
- Project has recent viewer activity

## Files Added Or Changed For The Migration

Core application:

- `server.js`
- `db/schema.sql`
- `lib/postgres-import.js`
- `lib/easm-metadata.js`

Scripts:

- `scripts/migrate.js`
- `scripts/import-json-to-postgres.js`
- `scripts/seed-viewer-links.js`
- `scripts/generate-viewer-links.js`
- `scripts/scan-shared-project-catalog.js`
- `scripts/extract-easm-metadata.js`

Tests:

- `test/postgres-import.test.js`

Configuration/docs:

- `package.json`
- `package-lock.json`
- `.env.example`
- `.gitignore`
- `README.md`

Frontend/admin-related files were also updated or added for the current CAD
Viewer and admin workflows.

