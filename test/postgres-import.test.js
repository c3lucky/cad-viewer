import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeViewerLinkForImport,
  normalizeWorkflowAccessForImport,
  upsertViewerLink,
  upsertWorkflowAccess,
} from "../lib/postgres-import.js";

test("normalizes viewer links with stable public model id", () => {
  const result = normalizeViewerLinkForImport({
    id: "share-226024-260106-100-650-07",
    queryHash: "0e5e8acf51ee0818710091a9",
    projectNumber: "226024",
    modelName: "260106-100-650-07",
    modelFileName: "260106-100-650-07.glb",
    storagePath: "/media/c3projectshare/226024/model.glb",
    hubspotAccessKey: "abc123",
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.publicModelId, "share-226024-260106-100-650-07");
  assert.equal(result.value.queryHash, "0e5e8acf51ee0818710091a9");
  assert.equal(result.value.hubspotAccessKey, "abc123");
  assert.equal(result.value.isActive, true);
});

test("rejects incomplete viewer links during import normalization", () => {
  const result = normalizeViewerLinkForImport({ queryHash: "missing-fields" });
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing required/);
});

test("normalizes workflow access records", () => {
  const result = normalizeWorkflowAccessForImport({
    projectNumber: "226024",
    accessKey: "key-123",
    hubspotObjectId: "58089114181",
    objectTypeId: "2-63259022",
    serialNumberName: "226024 - Testing",
    queryHash: "0e5e8acf51ee0818710091a9",
    modelFileName: "260106-100-650-07.glb",
    hasMappedModel: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.projectNumber, "226024");
  assert.equal(result.value.accessKey, "key-123");
  assert.equal(result.value.hasMappedModel, true);
});

test("viewer link upsert is duplicate-safe by query hash", async () => {
  const pool = createFakeImportPool();
  const link = normalizeViewerLinkForImport({
    id: "share-226024-test",
    queryHash: "hash-1",
    projectNumber: "226024",
    modelName: "model",
    modelFileName: "model.glb",
    storagePath: "/models/model.glb",
  }).value;

  assert.equal(await upsertViewerLink(pool, link), "inserted");
  assert.equal(await upsertViewerLink(pool, { ...link, modelName: "model-updated" }), "updated");
  assert.equal(pool.viewerLinks.get("hash-1").modelName, "model-updated");
});

test("workflow access upsert updates by access key, object id, or project number", async () => {
  const pool = createFakeImportPool();
  const record = normalizeWorkflowAccessForImport({
    projectNumber: "226024",
    accessKey: "key-1",
    hubspotObjectId: "object-1",
    queryHash: "hash-1",
    hasMappedModel: true,
  }).value;

  assert.equal(await upsertWorkflowAccess(pool, record), "inserted");
  assert.equal(
    await upsertWorkflowAccess(pool, {
      ...record,
      accessKey: "key-2",
      modelFileName: "updated.glb",
    }),
    "updated"
  );

  assert.equal(pool.workflowAccess.size, 1);
  assert.equal([...pool.workflowAccess.values()][0].accessKey, "key-2");
  assert.equal([...pool.workflowAccess.values()][0].modelFileName, "updated.glb");
});

function createFakeImportPool() {
  return {
    viewerLinks: new Map(),
    workflowAccess: new Map(),
    nextId: 1,
    async query(sql, params) {
      if (sql.includes("insert into viewer_links")) {
        const queryHash = params[1];
        const inserted = !this.viewerLinks.has(queryHash);
        this.viewerLinks.set(queryHash, {
          publicModelId: params[0],
          queryHash,
          projectNumber: params[2],
          modelName: params[3],
          modelFileName: params[4],
          storagePath: params[5],
        });
        return { rows: [{ inserted }] };
      }

      if (sql.includes("from hubspot_project_access") && sql.includes("select id")) {
        const [accessKey, hubspotObjectId, projectNumber] = params;
        const row = [...this.workflowAccess.values()].find(
          (entry) =>
            entry.accessKey === accessKey ||
            (hubspotObjectId && entry.hubspotObjectId === hubspotObjectId) ||
            entry.projectNumber === projectNumber
        );
        return { rows: row ? [{ id: row.id }] : [] };
      }

      if (sql.includes("update hubspot_project_access")) {
        const id = params[14];
        const updated = toWorkflowRow(id, params);
        this.workflowAccess.set(id, updated);
        return { rows: [] };
      }

      if (sql.includes("insert into hubspot_project_access")) {
        const id = `workflow-${this.nextId++}`;
        this.workflowAccess.set(id, toWorkflowRow(id, params));
        return { rows: [] };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function toWorkflowRow(id, params) {
  return {
    id,
    projectNumber: params[0],
    accessKey: params[1],
    hubspotObjectId: params[2],
    objectTypeId: params[3],
    serialNumberName: params[4],
    mappedModelId: params[5],
    queryHash: params[6],
    modelFileName: params[7],
    viewerUrl: params[8],
    hasMappedModel: params[9],
    firstSeenAt: params[10],
    lastSeenAt: params[11],
    lastWebhookEventId: params[12],
    isActive: params[13],
  };
}
