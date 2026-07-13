import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import {
  normalizeViewerLinkForImport,
  normalizeWorkflowAccessForImport,
  upsertViewerLink,
  upsertWorkflowAccess,
} from "../lib/postgres-import.js";

const root = process.cwd();
const viewerLinksPath = path.resolve(
  process.env.C3_VIEWER_LINKS_PATH || path.join(root, "data/viewer-links.json")
);
const workflowAccessPath = path.resolve(
  process.env.HUBSPOT_PROJECT_ACCESS_PATH ||
    path.join(root, "data/hubspot-project-access.json")
);

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to import JSON data into PostgreSQL.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: parseSslMode(process.env.DATABASE_SSL),
});

const summary = {
  viewerLinks: { inserted: 0, updated: 0, skipped: 0, failed: 0 },
  workflowAccess: { inserted: 0, updated: 0, skipped: 0, failed: 0 },
  errors: [],
};

try {
  await importViewerLinks();
  await importWorkflowAccess();
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await pool.end();
}

async function importViewerLinks() {
  const data = readJsonFile(viewerLinksPath, { links: [] });
  for (const rawLink of data.links || []) {
    const normalized = normalizeViewerLinkForImport(rawLink);
    if (!normalized.ok) {
      summary.viewerLinks.skipped += 1;
      summary.errors.push({ store: "viewer_links", error: normalized.error, source: rawLink.id || null });
      continue;
    }

    try {
      const result = await upsertViewerLink(pool, normalized.value);
      summary.viewerLinks[result] += 1;
    } catch (error) {
      summary.viewerLinks.failed += 1;
      summary.errors.push({
        store: "viewer_links",
        source: normalized.value.queryHash,
        error: error.message,
      });
    }
  }
}

async function importWorkflowAccess() {
  const data = readJsonFile(workflowAccessPath, { records: [] });
  for (const rawRecord of data.records || []) {
    const normalized = normalizeWorkflowAccessForImport(rawRecord);
    if (!normalized.ok) {
      summary.workflowAccess.skipped += 1;
      summary.errors.push({
        store: "hubspot_project_access",
        error: normalized.error,
        source: rawRecord.projectNumber || null,
      });
      continue;
    }

    try {
      const result = await upsertWorkflowAccess(pool, normalized.value);
      summary.workflowAccess[result] += 1;
    } catch (error) {
      summary.workflowAccess.failed += 1;
      summary.errors.push({
        store: "hubspot_project_access",
        source: normalized.value.projectNumber,
        error: error.message,
      });
    }
  }
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function parseSslMode(value) {
  if (!value || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return { rejectUnauthorized: true };
  if (value === "no-verify") return { rejectUnauthorized: false };
  return false;
}
