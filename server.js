import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { readEasmCatalog } from "./lib/easm-metadata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const app = express();
app.set("trust proxy", true);
const port = Number(process.env.PORT || 8766);
const host = process.env.HOST || "127.0.0.1";
const shareRoot = path.resolve(process.env.C3_SHARE_ROOT || "/media/c3projectshare");
const localModelRoot = path.resolve(__dirname, "models");
const allowedModelRoots = [shareRoot, localModelRoot];
const projectEasmMetadataCache = new Map();
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const adminUser = process.env.ADMIN_USERNAME || "";
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || "";
const adminSessionSecret = process.env.ADMIN_SESSION_SECRET || "";
const adminSessionCookie = "c3_admin_session";
const hubspotClientSecret = process.env.HUBSPOT_CLIENT_SECRET || "";
const hubspotPrivateAppToken = process.env.HUBSPOT_PRIVATE_APP_TOKEN || "";
const hubspotCustomObjectType = process.env.HUBSPOT_CUSTOM_OBJECT_TYPE || "";
const allowUnsignedHubspot =
  process.env.HUBSPOT_ALLOW_UNSIGNED === "true" && process.env.NODE_ENV !== "production";
const jsonFallbackEnabled = process.env.JSON_FALLBACK_ENABLED === "true";
const jsonBackupWriteEnabled = process.env.JSON_BACKUP_WRITE_ENABLED === "true";
const hubspotSignatureToleranceMs = Number(
  process.env.HUBSPOT_SIGNATURE_TOLERANCE_MS || 300000
);
const hubspotWebhookLogPath = path.resolve(
  process.env.HUBSPOT_WEBHOOK_LOG_PATH ||
    path.join(__dirname, "data", "hubspot-webhook-events.jsonl")
);
const hubspotWebhookToken = process.env.HUBSPOT_WEBHOOK_TOKEN || "";
const hubspotProjectAccessPath = path.resolve(
  process.env.HUBSPOT_PROJECT_ACCESS_PATH ||
    path.join(__dirname, "data", "hubspot-project-access.json")
);
const cadViewerAccessLogPath = path.resolve(
  process.env.CAD_VIEWER_ACCESS_LOG_PATH ||
    path.join(__dirname, "data", "cad-viewer-access-events.jsonl")
);
const easmCatalogCacheRoot = path.resolve(
  process.env.EASM_CATALOG_CACHE_ROOT ||
    path.join(__dirname, "data", "easm-catalog-cache")
);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: parseSslMode(process.env.DATABASE_SSL),
    })
  : null;

const fallbackLinks = loadFallbackLinks();
const workflowAccessRecords = loadWorkflowAccessRecords();

app.use(
  express.json({
    verify: (request, _response, buffer) => {
      request.rawBody = buffer.toString("utf8");
    },
  })
);
app.use(captureCadViewerAccess);

app.get("/api/health", async (_request, response) => {
  const database = pool ? await checkDatabase() : { configured: false };
  response.json({
    ok: true,
    database,
    storage: {
      mode: pool ? "postgres" : "json",
      jsonFallbackEnabled,
      jsonBackupWriteEnabled,
    },
    shareRoot,
  });
});

app.get("/api/admin/session", (request, response) => {
  const session = readAdminSession(request);
  response.json({
    authenticated: Boolean(session),
    user: session?.user || null,
  });
});

app.post("/api/admin/login", (request, response) => {
  if (!adminUser || !adminPasswordHash || !adminSessionSecret) {
    response.status(503).json({
      authenticated: false,
      error: "Admin login is not configured.",
    });
    return;
  }

  const { username, password } = request.body || {};
  const passwordHash = hashPassword(String(password || ""));
  const validUser = timingSafeEqual(String(username || ""), adminUser);
  const validPassword = timingSafeEqual(passwordHash, adminPasswordHash);

  if (!validUser || !validPassword) {
    response.status(401).json({
      authenticated: false,
      error: "Invalid username or password.",
    });
    return;
  }

  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const token = createAdminSessionToken({ user: adminUser, expiresAt });
  response.setHeader("Set-Cookie", serializeCookie(adminSessionCookie, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: true,
    path: "/",
    maxAge: 8 * 60 * 60,
  }));
  response.json({ authenticated: true, user: adminUser });
});

app.post("/api/admin/logout", (_request, response) => {
  response.setHeader("Set-Cookie", serializeCookie(adminSessionCookie, "", {
    httpOnly: true,
    sameSite: "Strict",
    secure: true,
    path: "/",
    maxAge: 0,
  }));
  response.json({ authenticated: false });
});

app.get("/api/admin/health", requireAdminSession, async (_request, response) => {
  const database = pool ? await checkDatabase() : { configured: false };
  response.json({
    ok: true,
    node: process.version,
    database,
    storage: {
      mode: pool ? "postgres" : "json",
      jsonFallbackEnabled,
      jsonBackupWriteEnabled,
    },
    mappings: fallbackLinks.length,
    hubspotSignatureConfigured: Boolean(hubspotClientSecret),
    publicBaseUrl,
  });
});

app.get("/api/admin/hubspot-webhook-events", requireAdminSession, async (request, response) => {
  const limit = Math.min(Math.max(Number(request.query.limit || 25), 1), 100);

  try {
    const events = await readRecentHubSpotWebhookEvents(limit);
    response.json({
      generatedAt: new Date().toISOString(),
      logPath: hubspotWebhookLogPath,
      count: events.length,
      events,
    });
  } catch (error) {
    console.error("hubspot webhook event log read failed", error);
    response.status(500).json({ error: "Unable to read HubSpot webhook event log." });
  }
});

app.get("/api/admin/viewer-access-events", requireAdminSession, async (request, response) => {
  const limit = Math.min(Math.max(Number(request.query.limit || 100), 1), 500);

  try {
    const events = await readRecentCadViewerAccessEvents(limit);
    response.json({
      generatedAt: new Date().toISOString(),
      logPath: cadViewerAccessLogPath,
      count: events.length,
      events,
    });
  } catch (error) {
    console.error("cad viewer access log read failed", error);
    response.status(500).json({ error: "Unable to read CAD viewer access log." });
  }
});

app.get("/api/admin/viewer-links", requireAdminSession, async (request, response) => {
  response.json(await buildViewerLinksResponse(request));
});

app.post(
  "/api/admin/viewer-links/:queryHash/access-credentials",
  requireAdminSession,
  async (request, response) => {
    const queryHash = normalizeHash(request.params.queryHash);
    if (!queryHash) {
      response.status(400).json({ error: "Missing viewer link hash." });
      return;
    }

    try {
      const record = await rotateViewerAccessCredentials(queryHash);
      if (!record) {
        response.status(404).json({ error: "Viewer link was not found." });
        return;
      }

      response.json({
        queryHash: record.queryHash,
        projectNumber: record.projectNumber,
        security: toSecurityMetadata(record),
        accessSecret: record.generatedAccessSecret,
        oneTimeSecret: true,
      });
    } catch (error) {
      console.error("access credential rotation failed", error);
      response.status(500).json({ error: "Unable to generate access credentials." });
    }
  }
);

app.post(
  "/api/admin/viewer-links/:queryHash/publish-hubspot",
  requireAdminSession,
  async (request, response) => {
    const queryHash = normalizeHash(request.params.queryHash);
    const record = await findViewerRecordByHash(queryHash);
    const hubspotObjectId = String(
      request.body?.hubspotObjectId || record?.projectNumber || ""
    ).trim();
    const accessSecret = String(request.body?.accessSecret || "").trim();

    if (!queryHash) {
      response.status(400).json({ error: "Missing viewer link hash." });
      return;
    }

    if (!record) {
      response.status(404).json({ error: "Viewer link was not found." });
      return;
    }

    if (!hubspotObjectId) {
      response.status(400).json({ error: "Project number is required to publish HubSpot data." });
      return;
    }

    if (!accessSecret) {
      response.status(400).json({
        error: "Generate or rotate credentials before publishing so the one-time secret is available.",
      });
      return;
    }

    try {
      const result = await publishViewerLinkToHubSpot(queryHash, {
        request,
        hubspotObjectId,
        accessSecret,
      });

      response.json(result);
    } catch (error) {
      console.error("hubspot publish failed", error);
      response
        .status(error.statusCode || 500)
        .json({ error: error.statusCode ? error.message : "Unable to publish HubSpot properties." });
    }
  }
);

app.get("/api/viewer-context", async (request, response) => {
  const queryHash = normalizeHash(request.query.q);
  if (!queryHash) {
    response.status(400).json({ error: "Missing required q query parameter." });
    return;
  }

  try {
    const context = await findViewerContext(queryHash);
    if (!context) {
      response.status(404).json({ error: "Viewer link was not found.", queryHash });
      return;
    }

    response.locals.viewerAccess = {
      eventType: "viewer-context",
      queryHash: context.queryHash,
      projectNumber: context.project?.number || null,
      modelId: context.model?.id || null,
      modelFileName: context.model?.fileName || null,
    };
    response.json(context);
  } catch (error) {
    console.error("viewer context lookup failed", error);
    response.status(500).json({ error: "Unable to resolve viewer context." });
  }
});

app.get("/api/project-viewer-context", async (request, response) => {
  const queryReference = normalizeHash(request.query.q);
  if (!queryReference) {
    response.status(400).json({ error: "Missing required q query parameter." });
    return;
  }

  try {
    const record =
      (await findViewerRecordByHash(queryReference)) ||
      (await findViewerRecordByWorkflowAccessKey(queryReference)) ||
      (await findViewerRecordByProjectNumber(queryReference));

    if (!record) {
      response.status(404).json({
        error: "Project viewer link was not found.",
        queryReference,
      });
      return;
    }

    response.locals.viewerAccess = {
      eventType: "project-viewer-context",
      queryHash: record.queryHash,
      projectNumber: record.projectNumber,
      modelId: record.id,
      modelFileName: record.modelFileName,
    };
    response.json(toViewerContext(record, await getRecordMetadataSource(record)));
  } catch (error) {
    console.error("project viewer context lookup failed", error);
    response.status(500).json({ error: "Unable to resolve project viewer context." });
  }
});

app.get("/api/hubspot/model-summary", verifyHubspotRequest, async (request, response) => {
  const queryHash = normalizeHash(request.query.check || request.query.q);
  const workflowAccess = request.workflowAccessRecord || null;
  if (!queryHash && !workflowAccess) {
    response.status(400).json({
      available: false,
      error: "Missing required check query parameter.",
      summary: "No GLB reference or C3 access key was supplied.",
    });
    return;
  }

  try {
    const record = workflowAccess?.viewerRecord || (await findViewerRecordByHash(queryHash));
    if (!record) {
      response.locals.viewerAccess = {
        eventType: "hubspot-model-summary",
        queryHash: queryHash || null,
        projectNumber: workflowAccess?.projectNumber || null,
        hubspotObjectId: workflowAccess?.hubspotObjectId || null,
        accessKeyRecognized: Boolean(workflowAccess),
        available: false,
      };
      response.status(workflowAccess ? 200 : 404).json({
        available: false,
        queryHash: queryHash || null,
        projectNumber: workflowAccess?.projectNumber || null,
        hubspotObjectId: workflowAccess?.hubspotObjectId || null,
        accessKeyRecognized: Boolean(workflowAccess),
        summary: workflowAccess
          ? `C3 access is registered for project ${workflowAccess.projectNumber}, but no mapped GLB model was found.`
          : "No GLB model was found for this reference.",
        results: [],
      });
      return;
    }

    if (
      request.viewerAccessRecord &&
      request.viewerAccessRecord.queryHash !== record.queryHash
    ) {
      response.status(403).json({
        available: false,
        queryHash,
        summary: "The project access key is not authorized for this model.",
        results: [],
      });
      return;
    }

    const resolvedModel = await resolveReadableModelPath(record);
    if (!resolvedModel.allowedPath) {
      response.status(403).json({
        available: false,
        queryHash,
        summary: "The mapped model path is not allowed.",
        results: [],
      });
      return;
    }

    if (!resolvedModel.path) {
      response.status(404).json({
        available: false,
        queryHash,
        summary: "The mapped GLB file could not be read.",
        checkedPaths: resolvedModel.checkedPaths,
        results: [],
      });
      return;
    }

    const stats = resolvedModel.stats;
    const viewerUrlReference = workflowAccess?.accessKey || record.queryHash;
    const viewerUrl = buildPublicViewerUrl(request, viewerUrlReference);
    const sizeMb = Number((stats.size / 1024 / 1024).toFixed(2));
    const modifiedAt = stats.mtime.toISOString();
    const metadataSource = await getRecordMetadataSource(record);
    const title = `Project ${record.projectNumber} CAD model`;
    const summary = `GLB model ${record.modelFileName} is available for project ${record.projectNumber}.`;

    response.locals.viewerAccess = {
      eventType: "hubspot-model-summary",
      queryHash: record.queryHash,
      projectNumber: record.projectNumber,
      modelId: record.id,
      modelFileName: record.modelFileName,
      hubspotObjectId: workflowAccess?.hubspotObjectId || record.hubspotObjectId || null,
      accessKeyRecognized: Boolean(workflowAccess),
      available: true,
    };
    response.json({
      available: true,
      queryHash: record.queryHash,
      projectNumber: record.projectNumber,
      modelName: record.modelName,
      modelFileName: record.modelFileName,
      fileSizeBytes: stats.size,
      fileSizeMb: sizeMb,
      lastModified: modifiedAt,
      metadataSource,
      viewerUrl,
      summary,
      results: [
        {
          objectId: record.queryHash,
          title,
          link: viewerUrl,
          properties: [
            { label: "Project", dataType: "STRING", value: record.projectNumber },
            { label: "Model", dataType: "STRING", value: record.modelFileName },
            {
              label: "Metadata source",
              dataType: "STRING",
              value: metadataSource?.fileName || "Not found",
            },
            { label: "Size", dataType: "STRING", value: `${sizeMb} MB` },
            { label: "Last modified", dataType: "DATETIME", value: modifiedAt },
          ],
          actions: [
            {
              type: "IFRAME",
              width: 1200,
              height: 800,
              uri: viewerUrl,
              label: "Open CAD Viewer",
            },
          ],
        },
      ],
    });
  } catch (error) {
    console.error("hubspot model summary failed", error);
    response.status(500).json({
      available: false,
      summary: "Unable to read GLB model summary.",
    });
  }
});

app.post("/api/hubspot/webhook", verifyHubspotRequest, async (request, response) => {
  const event = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    method: request.method,
    path: request.originalUrl,
    ip: request.ip,
    headers: redactRequestHeaders(request.headers),
    query: redactSecretFields(request.query || {}),
    body: redactSecretFields(request.body || null),
    rawBody: redactRawBodySecretFields(request.rawBody || ""),
    signature: {
      verified: request.hubspotSignatureVerified === true,
      skipped: request.hubspotSignatureSkipped === true,
      tokenVerified: request.hubspotWebhookTokenVerified === true,
    },
    viewerAccess: request.viewerAccessRecord
      ? {
          queryHash: request.viewerAccessRecord.queryHash,
          projectNumber: request.viewerAccessRecord.projectNumber,
          modelFileName: request.viewerAccessRecord.modelFileName,
        }
      : null,
  };

  try {
    const workflowAccess = await upsertWorkflowAccessFromWebhookEvent(event, request);
    const catalogRefresh = workflowAccess
      ? await refreshProjectEasmCatalog(workflowAccess.projectNumber, { force: true })
      : null;
    await appendHubSpotWebhookEvent(event);
    console.log(
      "hubspot workflow webhook accepted",
      JSON.stringify({
        id: event.id,
        receivedAt: event.receivedAt,
        objectId: event.body?.objectId || event.body?.object?.objectId || null,
        eventType: event.body?.eventType || event.body?.subscriptionType || null,
        projectNumber: workflowAccess?.projectNumber || null,
        accessLinked: Boolean(workflowAccess?.viewerRecord),
        catalogRefreshed: catalogRefresh?.refreshed === true,
        catalogPartCount: catalogRefresh?.partCount ?? null,
        signatureVerified: event.signature.verified,
        signatureSkipped: event.signature.skipped,
        tokenVerified: event.signature.tokenVerified,
      })
    );
    response.status(202).json({
      accepted: true,
      id: event.id,
      receivedAt: event.receivedAt,
      projectAccess: workflowAccess
        ? {
            projectNumber: workflowAccess.projectNumber,
            hubspotObjectId: workflowAccess.hubspotObjectId,
            hasAccessKey: Boolean(workflowAccess.accessKey),
            hasMappedModel: Boolean(workflowAccess.viewerRecord),
            queryHash: workflowAccess.viewerRecord?.queryHash || null,
            viewerUrl: workflowAccess.viewerRecord
              ? buildPublicViewerUrl(request, workflowAccess.viewerRecord.queryHash)
              : null,
          }
        : null,
      catalogRefresh,
    });
  } catch (error) {
    console.error("hubspot webhook capture failed", error);
    response.status(500).json({
      accepted: false,
      error: "Unable to capture HubSpot webhook request.",
    });
  }
});

app.get("/api/hubspot/webhook-status", async (request, response) => {
  try {
    const events = await readRecentHubSpotWebhookEvents(1);
    const latest = events[0] || null;
    const includeValues =
      hubspotWebhookToken && timingSafeEqual(getHubSpotWebhookToken(request), hubspotWebhookToken);
    response.json({
      configured: true,
      signatureConfigured: Boolean(hubspotClientSecret),
      tokenConfigured: Boolean(hubspotWebhookToken),
      receivedAny: Boolean(latest),
      valuesIncluded: Boolean(includeValues),
      latest: latest
        ? {
            id: latest.id,
            receivedAt: latest.receivedAt,
            method: latest.method,
            path: latest.path,
            propertySummary: summarizeWebhookProperties(latest.body),
            ...(includeValues
              ? {
                  propertyValuesSimple: simplifyWebhookPropertyValues(latest.body),
                  propertyValues: getWebhookProperties(latest.body),
                }
              : {}),
          }
        : null,
    });
  } catch (error) {
    console.error("hubspot webhook status read failed", error);
    response.status(500).json({ error: "Unable to read HubSpot webhook status." });
  }
});

app.get("/api/hubspot/webhook-events", async (request, response) => {
  if (!verifyReadOnlyWebhookToken(request)) {
    response.status(401).json({ error: "A valid webhook token is required." });
    return;
  }

  const limit = Math.min(Math.max(Number(request.query.limit || 50), 1), 200);

  try {
    const events = await readRecentHubSpotWebhookEvents(limit);
    response.json({
      generatedAt: new Date().toISOString(),
      count: events.length,
      events: events.map(toWebhookDashboardRow),
    });
  } catch (error) {
    console.error("hubspot webhook dashboard read failed", error);
    response.status(500).json({ error: "Unable to read HubSpot webhook dashboard data." });
  }
});

app.get("/api/viewer-links", async (request, response) => {
  try {
    response.json(await buildViewerLinksResponse(request));
  } catch (error) {
    console.error("viewer links lookup failed", error);
    response.status(500).json({ error: "Unable to read viewer links." });
  }
});

app.get("/api/models/:modelId/glb", async (request, response) => {
  try {
    const context = await findViewerModelById(request.params.modelId);
    if (!context) {
      response.status(404).json({ error: "Model was not found." });
      return;
    }

    const resolvedModel = await resolveReadableModelPath(context);
    if (!resolvedModel.allowedPath) {
      response.status(403).json({ error: "Model path is outside allowed roots." });
      return;
    }

    if (!resolvedModel.path) {
      response.status(404).json({
        error: "Unable to read model file.",
        modelFileName: context.modelFileName,
        checkedPaths: resolvedModel.checkedPaths,
      });
      return;
    }

    const stats = resolvedModel.stats;
    response.locals.viewerAccess = {
      eventType: "model-download",
      queryHash: context.queryHash,
      projectNumber: context.projectNumber,
      modelId: context.id,
      modelFileName: context.modelFileName,
      fileSizeBytes: stats.size,
    };
    response.type("model/gltf-binary");
    response.setHeader("Content-Length", stats.size);
    response.setHeader("Cache-Control", "private, max-age=300");
    fs.createReadStream(resolvedModel.path).pipe(response);
  } catch (error) {
    console.error("model stream failed", error);
    response.status(404).json({ error: "Unable to read model file." });
  }
});

app.get("/api/models/:modelId/catalog", async (request, response) => {
  try {
    const context = await findViewerModelById(request.params.modelId);
    if (!context) {
      response.status(404).json({ error: "Model was not found." });
      return;
    }

    const source = await getPrivateRecordMetadataSource(context);
    if (!source?.storagePath) {
      response.locals.viewerAccess = {
        eventType: "catalog-load",
        queryHash: context.queryHash,
        projectNumber: context.projectNumber,
        modelId: context.id,
        modelFileName: context.modelFileName,
        partCount: 0,
        componentCount: 0,
      };
      response.json({
        source: "EASM metadata",
        generatedAt: new Date().toISOString(),
        projectNumber: context.projectNumber,
        fileName: null,
        compressedBlockCount: 0,
        componentCount: 0,
        partCount: 0,
        parts: [],
        warning: "No EASM metadata source was found for this model.",
      });
      return;
    }

    const catalog = await getProjectEasmCatalog(context.projectNumber, source, {
      cacheKey: context.id,
    });
    response.locals.viewerAccess = {
      eventType: "catalog-load",
      queryHash: context.queryHash,
      projectNumber: context.projectNumber,
      modelId: context.id,
      modelFileName: context.modelFileName,
      partCount: catalog.partCount ?? null,
      componentCount: catalog.componentCount ?? null,
    };
    response.setHeader("Cache-Control", "private, max-age=300");
    response.json(catalog);
  } catch (error) {
    console.error("easm catalog extraction failed", error);
    response.status(500).json({ error: "Unable to extract EASM catalog metadata." });
  }
});

const adminDist = path.join(__dirname, "admin", "dist");
app.use("/admin", express.static(adminDist));
app.get("/admin/*", (_request, response) => {
  response.sendFile(path.join(adminDist, "index.html"));
});

app.get("/project-viewer", (_request, response) => {
  response.type("html").send(renderViewerPage("api/project-viewer-context"));
});

app.use(express.static(__dirname));

app.listen(port, host, () => {
  console.log(`CAD viewer listening on http://${host}:${port}`);
});

async function findViewerContext(queryHash) {
  const record =
    (await findViewerRecordByHash(queryHash)) ||
    (await findViewerRecordByWorkflowAccessKey(queryHash)) ||
    (await findViewerRecordByAccessKey(queryHash));

  if (!record) return null;

  return toViewerContext(record, await getRecordMetadataSource(record));
}

async function withJsonFallback(storeName, lookupKey, dbLookup, jsonLookup) {
  try {
    const record = await dbLookup();
    if (record || !jsonFallbackEnabled) return record;
    logJsonFallback(storeName, lookupKey);
    return jsonLookup();
  } catch (error) {
    if (!jsonFallbackEnabled) throw error;
    logJsonFallback(storeName, `${lookupKey}: ${error.message}`);
    return jsonLookup();
  }
}

function logJsonFallback(storeName, detail) {
  console.warn(
    "json fallback used",
    JSON.stringify({
      storeName,
      detail,
      databaseConfigured: Boolean(pool),
      jsonFallbackEnabled,
    })
  );
}

function fingerprintLogValue(value) {
  const raw = String(value || "");
  if (!raw) return "";
  return `${raw.slice(0, 4)}...${raw.slice(-8)}`;
}

async function findViewerRecordByHash(queryHash) {
  const jsonLookup = () =>
    fallbackLinks.find((link) => link.queryHash === queryHash && link.isActive !== false) || null;

  if (!pool) return jsonLookup();

  return withJsonFallback(
    "viewer_links.by_query_hash",
    queryHash,
    () => findViewerContextInPostgres(queryHash),
    jsonLookup
  );
}

async function findViewerRecordByAccessKey(accessKey) {
  if (!accessKey) return null;

  const jsonLookup = () =>
    fallbackLinks.find(
      (link) => link.hubspotAccessKey === accessKey && link.isActive !== false
    ) || null;

  if (!pool) return jsonLookup();

  return withJsonFallback(
    "viewer_links.by_access_key",
    fingerprintLogValue(accessKey),
    async () => {
      const result = await pool.query(
        `select ${viewerLinkSelectColumns()}
         from viewer_links
         where hubspot_access_key = $1 and is_active = true
         limit 1`,
        [accessKey]
      );
      return result.rows[0] ? mapDbRecord(result.rows[0]) : null;
    },
    jsonLookup
  );
}

async function findViewerRecordByWorkflowAccessKey(accessKey) {
  const workflowAccess = await findWorkflowAccessRecordByAccessKey(accessKey);
  if (!workflowAccess) return null;

  return (
    workflowAccess.viewerRecord ||
    (workflowAccess.queryHash ? await findViewerRecordByHash(workflowAccess.queryHash) : null) ||
    (workflowAccess.projectNumber
      ? await findViewerRecordByProjectNumber(workflowAccess.projectNumber)
      : null)
  );
}

async function findViewerRecords() {
  if (pool) {
    const result = await pool.query(
      `select ${viewerLinkSelectColumns()}
       from viewer_links
       where is_active = true
       order by project_number, model_file_name`
    );
    const records = result.rows.map(mapDbRecord);
    if (records.length || !jsonFallbackEnabled) return records;
    logJsonFallback("viewer_links.all", "empty postgres result");
    return getJsonViewerRecords();
  }

  return getJsonViewerRecords();
}

function getJsonViewerRecords() {
  return fallbackLinks
    .filter((link) => link.isActive !== false)
    .sort((a, b) => {
      const projectSort = a.projectNumber.localeCompare(b.projectNumber);
      if (projectSort !== 0) return projectSort;
      return a.modelFileName.localeCompare(b.modelFileName);
    });
}

async function findViewerRecordByProjectNumber(projectNumber) {
  const normalized = String(projectNumber || "").trim();
  if (!normalized) return null;

  const jsonLookup = () =>
    fallbackLinks
      .filter((link) => link.projectNumber === normalized && link.isActive !== false)
      .sort((a, b) => a.modelFileName.localeCompare(b.modelFileName))[0] || null;

  if (!pool) return jsonLookup();

  return withJsonFallback(
    "viewer_links.by_project_number",
    normalized,
    async () => {
      const result = await pool.query(
        `select ${viewerLinkSelectColumns()}
         from viewer_links
         where project_number = $1 and is_active = true
         order by model_file_name
         limit 1`,
        [normalized]
      );
      return result.rows[0] ? mapDbRecord(result.rows[0]) : null;
    },
    jsonLookup
  );
}

async function findViewerModelById(modelId) {
  const jsonLookup = () => fallbackLinks.find((link) => link.id === modelId) || null;
  if (!pool) return jsonLookup();

  return withJsonFallback(
    "viewer_links.by_model_id",
    modelId,
    async () => {
      const result = await pool.query(
        `select ${viewerLinkSelectColumns()}
         from viewer_links
         where is_active = true
           and (public_model_id = $1 or id::text = $1)
         limit 1`,
        [modelId]
      );
      return result.rows[0] ? mapDbRecord(result.rows[0]) : null;
    },
    jsonLookup
  );
}

async function findViewerContextInPostgres(queryHash) {
  const result = await pool.query(
    `select ${viewerLinkSelectColumns()}
     from viewer_links
     where query_hash = $1 and is_active = true
     limit 1`,
    [queryHash]
  );

  return result.rows[0] ? mapDbRecord(result.rows[0]) : null;
}

function toViewerContext(record, metadataSource = null) {
  return {
    queryHash: record.queryHash,
    project: {
      number: record.projectNumber,
    },
    model: {
      id: record.id,
      name: record.modelName,
      fileName: record.modelFileName,
      url: `api/models/${encodeURIComponent(record.id)}/glb`,
    },
    metadata: {
      source: metadataSource,
    },
    dataEndpoints: {
      catalog: `api/models/${encodeURIComponent(record.id)}/catalog`,
      inventory: "mock-api/inventory.json",
      orderRequest: "mock-api/order-request.json",
    },
  };
}

function renderViewerPage(contextEndpoint) {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const configScript = `<script>window.CAD_VIEWER_CONTEXT_ENDPOINT = ${JSON.stringify(
    contextEndpoint
  )};</script>`;
  return html.replace("</head>", `    ${configScript}\n  </head>`);
}

function mapDbRecord(row) {
  return {
    id: row.public_model_id || String(row.id),
    dbId: String(row.id),
    publicModelId: row.public_model_id || null,
    queryHash: row.query_hash,
    projectNumber: row.project_number,
    modelName: row.model_name,
    modelFileName: row.model_file_name,
    storagePath: row.storage_path,
    metadataSource: null,
    hubspotAccessKey: row.hubspot_access_key || null,
    hubspotAccessSecretHash: row.hubspot_access_secret_hash || null,
    hubspotAccessSecretLast4: row.hubspot_access_secret_last4 || null,
    hubspotAccessGeneratedAt: row.hubspot_access_generated_at
      ? new Date(row.hubspot_access_generated_at).toISOString()
      : null,
    hubspotAccessRotatedAt: row.hubspot_access_rotated_at
      ? new Date(row.hubspot_access_rotated_at).toISOString()
      : null,
    hubspotObjectId: row.hubspot_object_id || null,
    hubspotPublishedAt: row.hubspot_published_at
      ? new Date(row.hubspot_published_at).toISOString()
      : null,
    isActive: row.is_active,
  };
}

function viewerLinkSelectColumns() {
  return [
    "id",
    "public_model_id",
    "query_hash",
    "project_number",
    "model_name",
    "model_file_name",
    "storage_path",
    "hubspot_access_key",
    "hubspot_access_secret_hash",
    "hubspot_access_secret_last4",
    "hubspot_access_generated_at",
    "hubspot_access_rotated_at",
    "hubspot_object_id",
    "hubspot_published_at",
    "is_active",
  ].join(", ");
}

function toSecurityMetadata(record) {
  return {
    hubspotAccessEnabled: Boolean(record.hubspotAccessKey && record.hubspotAccessSecretHash),
    hubspotAccessKey: record.hubspotAccessKey || null,
    hubspotAccessSecretLast4: record.hubspotAccessSecretLast4 || null,
    generatedAt: record.hubspotAccessGeneratedAt || null,
    rotatedAt: record.hubspotAccessRotatedAt || null,
    hubspotObjectId: record.hubspotObjectId || null,
    publishedAt: record.hubspotPublishedAt || null,
  };
}

function createFallbackLinks() {
  const localModel = path.join(localModelRoot, "226022-00_COMP.glb");
  return [
    {
      id: "local-226022",
      queryHash: "demo-226022",
      projectNumber: "226022",
      modelName: "226022-00",
      modelFileName: "226022-00_COMP.glb",
      storagePath: localModel,
      metadataSource: null,
      isActive: true,
    },
  ];
}

function loadFallbackLinks() {
  const dataPath = path.join(__dirname, "data/viewer-links.json");
  try {
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    if (Array.isArray(data.links) && data.links.length) {
      return data.links.map((link) => ({
        id: String(link.id),
        queryHash: link.queryHash,
        projectNumber: link.projectNumber,
        modelName: link.modelName,
        modelFileName: link.modelFileName,
        storagePath: link.storagePath,
        metadataSource: normalizeMetadataSource(link.metadataSource),
        hubspotAccessKey: link.hubspotAccessKey || null,
        hubspotAccessSecretHash: link.hubspotAccessSecretHash || null,
        hubspotAccessSecretLast4: link.hubspotAccessSecretLast4 || null,
        hubspotAccessGeneratedAt: link.hubspotAccessGeneratedAt || null,
        hubspotAccessRotatedAt: link.hubspotAccessRotatedAt || null,
        hubspotObjectId: link.hubspotObjectId || null,
        hubspotPublishedAt: link.hubspotPublishedAt || null,
        isActive: link.isActive !== false,
      }));
    }
  } catch (error) {
    console.warn(`Unable to load ${dataPath}; using local demo mapping.`, error.message);
  }

  return createFallbackLinks();
}

function loadWorkflowAccessRecords() {
  try {
    const data = JSON.parse(fs.readFileSync(hubspotProjectAccessPath, "utf8"));
    return Array.isArray(data.records) ? data.records.map(normalizeWorkflowAccessRecord) : [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Unable to load ${hubspotProjectAccessPath}; using empty access registry.`, error.message);
    }
    return [];
  }
}

function normalizeWorkflowAccessRecord(record) {
  return {
    projectNumber: String(record.projectNumber || "").trim(),
    accessKey: String(record.accessKey || "").trim(),
    hubspotObjectId: String(record.hubspotObjectId || "").trim(),
    objectTypeId: String(record.objectTypeId || "").trim(),
    serialNumberName: String(record.serialNumberName || "").trim(),
    queryHash: record.queryHash || null,
    modelFileName: record.modelFileName || null,
    viewerUrl: record.viewerUrl || null,
    hasMappedModel: record.hasMappedModel === true,
    firstSeenAt: record.firstSeenAt || null,
    lastSeenAt: record.lastSeenAt || null,
    lastWebhookEventId: record.lastWebhookEventId || null,
  };
}

async function upsertWorkflowAccessFromWebhookEvent(event, request) {
  const values = simplifyWebhookPropertyValues(event.body);
  const projectNumber = String(
    values.projid ||
      values.projectId ||
      values.project_id ||
      event.body?.projectId ||
      event.body?.project_id ||
      ""
  ).trim();
  const accessKey = String(
    values.c3_access_key ||
      values.cad_authorization_key ||
      values.access_key ||
      event.body?.c3_access_key ||
      event.body?.cad_authorization_key ||
      event.body?.access_key ||
      ""
  ).trim();

  if (!projectNumber || !accessKey) return null;

  const hubspotObjectId = String(event.body?.objectId || values.hs_object_id || "").trim();
  const objectTypeId = String(event.body?.objectTypeId || "").trim();
  const serialNumberName = String(
    values.serial_number_name ||
      values.serialNumberName ||
      event.body?.serial_number_name ||
      event.body?.serialNumberName ||
      ""
  ).trim();
  const viewerRecord = await findViewerRecordByProjectNumber(projectNumber);
  const now = event.receivedAt || new Date().toISOString();

  if (pool) {
    const updated = await upsertWorkflowAccessInPostgres({
      projectNumber,
      accessKey,
      hubspotObjectId,
      objectTypeId,
      serialNumberName,
      queryHash: viewerRecord?.queryHash || null,
      mappedModelId: viewerRecord?.id || null,
      modelFileName: viewerRecord?.modelFileName || null,
      viewerUrl: viewerRecord ? buildPublicViewerUrl(request, viewerRecord.queryHash) : null,
      hasMappedModel: Boolean(viewerRecord),
      firstSeenAt: now,
      lastSeenAt: now,
      lastWebhookEventId: event.id,
    });

    if (jsonBackupWriteEnabled) {
      await upsertWorkflowAccessJsonBackup(updated, viewerRecord, now, event.id);
    }

    return {
      ...updated,
      viewerRecord,
    };
  }

  const index = workflowAccessRecords.findIndex(
    (record) =>
      record.accessKey === accessKey ||
      (hubspotObjectId && record.hubspotObjectId === hubspotObjectId) ||
      record.projectNumber === projectNumber
  );
  const previous = index === -1 ? null : workflowAccessRecords[index];
  const updated = normalizeWorkflowAccessRecord({
    ...previous,
    projectNumber,
    accessKey,
    hubspotObjectId,
    objectTypeId,
    serialNumberName,
    queryHash: viewerRecord?.queryHash || null,
    modelFileName: viewerRecord?.modelFileName || null,
    viewerUrl: viewerRecord ? buildPublicViewerUrl(request, viewerRecord.queryHash) : null,
    hasMappedModel: Boolean(viewerRecord),
    firstSeenAt: previous?.firstSeenAt || now,
    lastSeenAt: now,
    lastWebhookEventId: event.id,
  });

  if (index === -1) {
    workflowAccessRecords.push(updated);
  } else {
    workflowAccessRecords[index] = updated;
  }

  if (viewerRecord && !pool) {
    const linkIndex = fallbackLinks.findIndex((link) => link.queryHash === viewerRecord.queryHash);
    if (linkIndex !== -1) {
      fallbackLinks[linkIndex] = {
        ...fallbackLinks[linkIndex],
        hubspotAccessKey: accessKey,
        hubspotObjectId: hubspotObjectId || fallbackLinks[linkIndex].hubspotObjectId || null,
      };
      await persistFallbackLinks();
    }
  }

  await persistWorkflowAccessRecords();
  return {
    ...updated,
    viewerRecord,
  };
}

async function upsertWorkflowAccessInPostgres(record) {
  const existing = await pool.query(
    `select id
     from hubspot_project_access
     where is_active = true
       and (
         access_key = $1
         or ($2::text is not null and hubspot_object_id = $2)
         or project_number = $3
       )
     order by
       case
         when access_key = $1 then 0
         when $2::text is not null and hubspot_object_id = $2 then 1
         else 2
       end
     limit 1`,
    [record.accessKey, record.hubspotObjectId || null, record.projectNumber]
  );

  const values = [
    record.projectNumber,
    record.accessKey,
    record.hubspotObjectId || null,
    record.objectTypeId || null,
    record.serialNumberName || null,
    record.mappedModelId || null,
    record.queryHash || null,
    record.modelFileName || null,
    record.viewerUrl || null,
    record.hasMappedModel === true,
    record.firstSeenAt || null,
    record.lastSeenAt || null,
    record.lastWebhookEventId || null,
  ];

  if (existing.rows[0]) {
    const result = await pool.query(
      `update hubspot_project_access
       set project_number = $1,
           access_key = $2,
           hubspot_object_id = $3,
           object_type_id = $4,
           serial_number_name = $5,
           mapped_model_id = $6,
           query_hash = $7,
           model_file_name = $8,
           viewer_url = $9,
           has_mapped_model = $10,
           first_seen_at = coalesce(first_seen_at, $11),
           last_seen_at = $12,
           last_webhook_event_id = $13,
           updated_at = now()
       where id = $14
       returning ${workflowAccessSelectColumns()}`,
      [...values, existing.rows[0].id]
    );

    return mapWorkflowAccessDbRecord(result.rows[0]);
  }

  const result = await pool.query(
    `insert into hubspot_project_access
      (project_number, access_key, hubspot_object_id, object_type_id, serial_number_name,
       mapped_model_id, query_hash, model_file_name, viewer_url, has_mapped_model,
       first_seen_at, last_seen_at, last_webhook_event_id, is_active)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
     returning ${workflowAccessSelectColumns()}`,
    [
      ...values,
    ]
  );

  return mapWorkflowAccessDbRecord(result.rows[0]);
}

async function upsertWorkflowAccessJsonBackup(record, viewerRecord, now, eventId) {
  const index = workflowAccessRecords.findIndex(
    (entry) =>
      entry.accessKey === record.accessKey ||
      (record.hubspotObjectId && entry.hubspotObjectId === record.hubspotObjectId) ||
      entry.projectNumber === record.projectNumber
  );
  const previous = index === -1 ? null : workflowAccessRecords[index];
  const updated = normalizeWorkflowAccessRecord({
    ...previous,
    ...record,
    firstSeenAt: previous?.firstSeenAt || record.firstSeenAt || now,
    lastSeenAt: record.lastSeenAt || now,
    lastWebhookEventId: record.lastWebhookEventId || eventId,
  });

  if (index === -1) {
    workflowAccessRecords.push(updated);
  } else {
    workflowAccessRecords[index] = updated;
  }

  if (viewerRecord) {
    await upsertFallbackLinkAccessBackup(viewerRecord.queryHash, {
      hubspotAccessKey: record.accessKey,
      hubspotObjectId: record.hubspotObjectId || null,
    });
  }

  await persistWorkflowAccessRecords();
}

async function persistWorkflowAccessRecords() {
  await fs.promises.mkdir(path.dirname(hubspotProjectAccessPath), { recursive: true });
  await fs.promises.writeFile(
    hubspotProjectAccessPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "HubSpot workflow c3_access_key registry",
        records: workflowAccessRecords,
      },
      null,
      2
    )}\n`
  );
}

async function findWorkflowAccessRecordByAccessKey(accessKey) {
  const normalized = String(accessKey || "").trim();
  if (!normalized) return null;

  const jsonLookup = () => {
    const record = workflowAccessRecords.find((entry) => entry.accessKey === normalized);
    if (!record) return null;

    const viewerRecord = record.queryHash
      ? fallbackLinks.find((link) => link.queryHash === record.queryHash && link.isActive !== false)
      : fallbackLinks.find(
          (link) => link.projectNumber === record.projectNumber && link.isActive !== false
        );

    return {
      ...record,
      viewerRecord: viewerRecord || null,
    };
  };

  if (!pool) return jsonLookup();

  return withJsonFallback(
    "hubspot_project_access.by_access_key",
    fingerprintLogValue(normalized),
    async () => {
      const result = await pool.query(
        `select ${workflowAccessSelectColumns()}
         from hubspot_project_access
         where access_key = $1 and is_active = true
         limit 1`,
        [normalized]
      );
      if (!result.rows[0]) return null;

      const record = mapWorkflowAccessDbRecord(result.rows[0]);
      const viewerRecord =
        (record.queryHash ? await findViewerRecordByHash(record.queryHash) : null) ||
        (record.projectNumber ? await findViewerRecordByProjectNumber(record.projectNumber) : null);

      return {
        ...record,
        viewerRecord,
      };
    },
    jsonLookup
  );
}

function mapWorkflowAccessDbRecord(row) {
  return {
    projectNumber: row.project_number,
    accessKey: row.access_key,
    hubspotObjectId: row.hubspot_object_id || "",
    objectTypeId: row.object_type_id || "",
    serialNumberName: row.serial_number_name || "",
    mappedModelId: row.mapped_model_id || null,
    queryHash: row.query_hash || null,
    modelFileName: row.model_file_name || null,
    viewerUrl: row.viewer_url || null,
    hasMappedModel: row.has_mapped_model === true,
    firstSeenAt: row.first_seen_at ? new Date(row.first_seen_at).toISOString() : null,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    lastWebhookEventId: row.last_webhook_event_id || null,
  };
}

function workflowAccessSelectColumns() {
  return [
    "project_number",
    "access_key",
    "hubspot_object_id",
    "object_type_id",
    "serial_number_name",
    "mapped_model_id",
    "query_hash",
    "model_file_name",
    "viewer_url",
    "has_mapped_model",
    "first_seen_at",
    "last_seen_at",
    "last_webhook_event_id",
    "is_active",
  ].join(", ");
}

function normalizeMetadataSource(source) {
  if (!source || typeof source !== "object") return null;

  return {
    type: source.type || "easm",
    fileName: source.fileName || (source.storagePath ? path.basename(source.storagePath) : ""),
    storagePath: source.storagePath || "",
    relativePath: source.relativePath || "",
    fileSizeBytes: source.fileSizeBytes ?? null,
    lastModified: source.lastModified || source.modifiedAt || null,
    archiveEntries: Array.isArray(source.archiveEntries) ? source.archiveEntries : [],
    materials: source.materials || null,
  };
}

async function getRecordMetadataSource(record) {
  const source = await getPrivateRecordMetadataSource(record);
  if (!source) return null;

  return {
    type: source.type,
    fileName: source.fileName,
    relativePath: source.relativePath,
    fileSizeBytes: source.fileSizeBytes,
    lastModified: source.lastModified,
    archiveEntries: source.archiveEntries,
    materials: source.materials,
  };
}

async function getPrivateRecordMetadataSource(record) {
  const directSource = normalizeMetadataSource(record.metadataSource);
  return directSource?.storagePath
    ? await enrichMetadataSource(directSource)
    : await getProjectEasmMetadata(record.projectNumber);
}

async function getProjectEasmMetadata(projectNumber) {
  if (!projectNumber) return null;
  if (projectEasmMetadataCache.has(projectNumber)) {
    return projectEasmMetadataCache.get(projectNumber);
  }

  const projectRoot = path.join(shareRoot, projectNumber);
  const easmFiles = await findFilesByExtension(projectRoot, ".easm");
  const preferredEasm = choosePreferredEasm(easmFiles, projectNumber);
  const metadata = preferredEasm
    ? await enrichMetadataSource({
        type: "easm",
        fileName: path.basename(preferredEasm),
        storagePath: preferredEasm,
        relativePath: path.relative(shareRoot, preferredEasm),
      })
    : null;

  projectEasmMetadataCache.set(projectNumber, metadata);
  return metadata;
}

async function getProjectEasmCatalog(projectNumber, source = null, options = {}) {
  const metadataSource = source || (await getProjectEasmMetadata(projectNumber));
  if (!metadataSource?.storagePath) {
    return {
      source: "EASM metadata",
      generatedAt: new Date().toISOString(),
      projectNumber,
      parts: [],
      error: "No EASM metadata source was found for this project.",
    };
  }

  const cachePath = getEasmCatalogCachePath(options.cacheKey || projectNumber);
  const cached = options.force ? null : await readEasmCatalogCache(cachePath, metadataSource);
  if (cached) return cached.catalog;

  const catalog = await readEasmCatalog(metadataSource.storagePath);
  const enrichedCatalog = {
    ...catalog,
    projectNumber,
    metadataSource: {
      type: metadataSource.type,
      fileName: metadataSource.fileName,
      relativePath: metadataSource.relativePath,
      fileSizeBytes: metadataSource.fileSizeBytes,
      lastModified: metadataSource.lastModified,
    },
  };

  await writeEasmCatalogCache(cachePath, metadataSource, enrichedCatalog);
  return enrichedCatalog;
}

async function refreshProjectEasmCatalog(projectNumber, options = {}) {
  try {
    const metadataSource = await getProjectEasmMetadata(projectNumber);
    if (!metadataSource?.storagePath) {
      return {
        refreshed: false,
        projectNumber,
        reason: "No EASM metadata source was found for this project.",
      };
    }

    const catalog = await getProjectEasmCatalog(projectNumber, metadataSource, {
      force: options.force === true,
    });

    return {
      refreshed: true,
      projectNumber,
      fileName: metadataSource.fileName,
      partCount: catalog.partCount,
      componentCount: catalog.componentCount,
      generatedAt: catalog.generatedAt,
    };
  } catch (error) {
    console.error("easm catalog refresh failed", { projectNumber, error: error.message });
    return {
      refreshed: false,
      projectNumber,
      error: "Unable to refresh EASM catalog.",
    };
  }
}

async function readEasmCatalogCache(cachePath, metadataSource) {
  try {
    const cached = JSON.parse(await fs.promises.readFile(cachePath, "utf8"));
    if (
      cached?.source?.storagePath === metadataSource.storagePath &&
      cached?.source?.lastModified === metadataSource.lastModified &&
      cached?.catalog
    ) {
      return cached;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Unable to read EASM catalog cache ${cachePath}.`, error.message);
    }
  }

  return null;
}

async function writeEasmCatalogCache(cachePath, metadataSource, catalog) {
  await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.promises.writeFile(
    cachePath,
    `${JSON.stringify(
      {
        cachedAt: new Date().toISOString(),
        source: {
          storagePath: metadataSource.storagePath,
          fileName: metadataSource.fileName,
          relativePath: metadataSource.relativePath,
          lastModified: metadataSource.lastModified,
          fileSizeBytes: metadataSource.fileSizeBytes,
        },
        catalog,
      },
      null,
      2
    )}\n`
  );
}

function getEasmCatalogCachePath(projectNumber) {
  return path.join(easmCatalogCacheRoot, `${sanitizeCacheKey(projectNumber)}.json`);
}

function sanitizeCacheKey(value) {
  return String(value || "unknown").replace(/[^a-z0-9_.-]/gi, "_");
}

async function findFilesByExtension(directory, extension) {
  const results = [];

  async function walk(currentDirectory) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
        results.push(fullPath);
      }
    }
  }

  await walk(directory);
  return results;
}

function choosePreferredEasm(files, projectNumber) {
  return (
    files.find((file) => path.basename(file, path.extname(file)) === `${projectNumber}-00`) ||
    files.find((file) => path.basename(file).includes(projectNumber)) ||
    files[0] ||
    null
  );
}

async function enrichMetadataSource(source) {
  if (!source.storagePath) return source;

  try {
    const stats = await fs.promises.stat(source.storagePath);
    return {
      ...source,
      fileSizeBytes: stats.size,
      lastModified: stats.mtime.toISOString(),
      archiveEntries: source.archiveEntries?.length
        ? source.archiveEntries
        : await listEasmArchiveEntries(source.storagePath),
      materials: source.materials || (await readEasmMaterialsSummary(source.storagePath)),
    };
  } catch {
    return {
      ...source,
      fileSizeBytes: null,
      lastModified: null,
      archiveEntries: [],
      materials: null,
    };
  }
}

async function listEasmArchiveEntries(filePath) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-l", filePath], { maxBuffer: 1024 * 1024 });
    return stdout
      .split("\n")
      .map((line) => line.match(/^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/))
      .filter(Boolean)
      .map((match) => ({
        name: match[2].trim(),
        sizeBytes: Number(match[1]),
      }));
  } catch {
    return [];
  }
}

async function readEasmMaterialsSummary(filePath) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", filePath, "materials.xml"], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const materialNames = [...stdout.matchAll(/\bMaterialName="([^"]*)"/g)]
      .map((match) => match[1])
      .filter(Boolean);

    return {
      entityCount: (stdout.match(/<Entity\b/g) || []).length,
      materialNames: countTopValues(materialNames, 20),
    };
  } catch {
    return null;
  }
}

function countTopValues(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function normalizeHash(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "";
  return String(raw).trim();
}

function resolveAllowedModelPath(storagePath) {
  const resolved = path.resolve(storagePath);
  const isAllowed = allowedModelRoots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });

  return isAllowed ? resolved : null;
}

async function resolveReadableModelPath(record) {
  const primaryPath = resolveAllowedModelPath(record.storagePath);
  const checkedPaths = [];

  if (!primaryPath) {
    return {
      allowedPath: false,
      path: null,
      stats: null,
      checkedPaths,
    };
  }

  checkedPaths.push(primaryPath);

  const primaryStats = await statReadableFile(primaryPath);
  if (primaryStats) {
    return {
      allowedPath: true,
      path: primaryPath,
      stats: primaryStats,
      checkedPaths,
    };
  }

  const localFileName = path.basename(record.modelFileName || record.storagePath || "");
  const localPath = localFileName ? resolveAllowedModelPath(path.join(localModelRoot, localFileName)) : null;

  if (localPath && localPath !== primaryPath) {
    checkedPaths.push(localPath);
    const localStats = await statReadableFile(localPath);
    if (localStats) {
      return {
        allowedPath: true,
        path: localPath,
        stats: localStats,
        checkedPaths,
      };
    }
  }

  return {
    allowedPath: true,
    path: null,
    stats: null,
    checkedPaths,
  };
}

async function statReadableFile(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

function parseSslMode(value) {
  if (!value || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return { rejectUnauthorized: true };
  if (value === "no-verify") return { rejectUnauthorized: false };
  return false;
}

async function buildViewerLinksResponse(request) {
  const records = await findViewerRecords();
  const workflowRecords = await findWorkflowAccessRecordsForDashboard();
  const links = await Promise.all(
    records.map(async (record) => {
      const resolvedModel = await resolveReadableModelPath(record);
      let fileSizeBytes = null;
      let fileSizeMb = null;
      let lastModified = null;
      const readable = Boolean(resolvedModel.path);

      if (resolvedModel.stats) {
        fileSizeBytes = resolvedModel.stats.size;
        fileSizeMb = Number((resolvedModel.stats.size / 1024 / 1024).toFixed(2));
        lastModified = resolvedModel.stats.mtime.toISOString();
      }

      return {
        queryHash: record.queryHash,
        projectNumber: record.projectNumber,
        modelName: record.modelName,
        modelFileName: record.modelFileName,
        fileSizeBytes,
        fileSizeMb,
        lastModified,
        readable,
        metadataSource: await getRecordMetadataSource(record),
        viewerUrl: buildPublicViewerUrl(request, record.queryHash),
        hubspotCheckUrl: `${buildPublicBaseUrl(request)}/api/hubspot/model-summary?check=${encodeURIComponent(
          record.queryHash
        )}`,
        security: toSecurityMetadata(record),
      };
    })
  );

  return {
    generatedAt: new Date().toISOString(),
    count: links.length,
    links,
    workflowAccessRecords: workflowRecords.map((record) => ({
      projectNumber: record.projectNumber,
      hubspotObjectId: record.hubspotObjectId,
      objectTypeId: record.objectTypeId,
      serialNumberName: record.serialNumberName,
      hasAccessKey: Boolean(record.accessKey),
      accessKeyLast8: record.accessKey ? record.accessKey.slice(-8) : null,
      hasMappedModel: record.hasMappedModel,
      queryHash: record.queryHash,
      modelFileName: record.modelFileName,
      viewerUrl: record.viewerUrl,
      firstSeenAt: record.firstSeenAt,
      lastSeenAt: record.lastSeenAt,
      lastWebhookEventId: record.lastWebhookEventId,
    })),
  };
}

async function findWorkflowAccessRecordsForDashboard() {
  const jsonRecords = () => workflowAccessRecords;
  if (!pool) return jsonRecords();

  try {
    const result = await pool.query(
      `select ${workflowAccessSelectColumns()}
       from hubspot_project_access
       where is_active = true
       order by last_seen_at desc nulls last, project_number`
    );
    const records = result.rows.map(mapWorkflowAccessDbRecord);
    if (records.length || !jsonFallbackEnabled) return records;
    logJsonFallback("hubspot_project_access.all", "empty postgres result");
    return jsonRecords();
  } catch (error) {
    if (!jsonFallbackEnabled) throw error;
    logJsonFallback("hubspot_project_access.all", error.message);
    return jsonRecords();
  }
}

async function rotateViewerAccessCredentials(queryHash) {
  if (!pool) return rotateFallbackAccessCredentials(queryHash);

  const current = await findViewerContextInPostgres(queryHash);
  if (!current) return null;

  const credentials = createViewerAccessCredentials(current.projectNumber);
  const secretHash = hashSecret(credentials.accessSecret);
  const rotatedAt = new Date();
  const generatedAt = current.hubspotAccessGeneratedAt
    ? new Date(current.hubspotAccessGeneratedAt)
    : rotatedAt;

  const result = await pool.query(
    `update viewer_links
     set hubspot_access_key = $1,
         hubspot_access_secret_hash = $2,
         hubspot_access_secret_last4 = $3,
         hubspot_access_generated_at = $4,
         hubspot_access_rotated_at = $5,
         updated_at = now()
     where query_hash = $6 and is_active = true
     returning ${viewerLinkSelectColumns()}`,
    [
      credentials.accessKey,
      secretHash,
      credentials.accessSecret.slice(-4),
      generatedAt,
      rotatedAt,
      queryHash,
    ]
  );

  if (!result.rows[0]) return null;

  const updated = mapDbRecord(result.rows[0]);
  if (jsonBackupWriteEnabled) {
    await upsertFallbackLinkAccessBackup(updated.queryHash, {
      hubspotAccessKey: updated.hubspotAccessKey,
      hubspotAccessSecretHash: updated.hubspotAccessSecretHash,
      hubspotAccessSecretLast4: updated.hubspotAccessSecretLast4,
      hubspotAccessGeneratedAt: updated.hubspotAccessGeneratedAt,
      hubspotAccessRotatedAt: updated.hubspotAccessRotatedAt,
    });
  }

  return {
    ...updated,
    generatedAccessSecret: credentials.accessSecret,
  };
}

async function rotateFallbackAccessCredentials(queryHash) {
  const index = fallbackLinks.findIndex(
    (link) => link.queryHash === queryHash && link.isActive !== false
  );
  if (index === -1) return null;

  const current = fallbackLinks[index];
  const credentials = createViewerAccessCredentials(current.projectNumber);
  const now = new Date().toISOString();
  const updated = {
    ...current,
    hubspotAccessKey: credentials.accessKey,
    hubspotAccessSecretHash: hashSecret(credentials.accessSecret),
    hubspotAccessSecretLast4: credentials.accessSecret.slice(-4),
    hubspotAccessGeneratedAt: current.hubspotAccessGeneratedAt || now,
    hubspotAccessRotatedAt: now,
  };

  fallbackLinks[index] = updated;
  await persistFallbackLinks();

  return {
    ...updated,
    generatedAccessSecret: credentials.accessSecret,
  };
}

async function publishViewerLinkToHubSpot(queryHash, options) {
  const record = await findViewerRecordByHash(queryHash);
  if (!record) return null;

  if (
    !record.hubspotAccessKey ||
    !record.hubspotAccessSecretHash ||
    !timingSafeEqual(hashSecret(options.accessSecret), record.hubspotAccessSecretHash)
  ) {
    const error = new Error(
      "Generate or rotate credentials before publishing so the current secret can be synced."
    );
    error.statusCode = 400;
    throw error;
  }

  const payload = buildHubSpotPropertyPayload(record, {
    request: options.request,
    accessSecret: options.accessSecret,
  });

  const publishedAt = new Date().toISOString();
  let hubspotResponse = null;
  let mode = "prepared";

  if (hubspotPrivateAppToken && hubspotCustomObjectType) {
    const hubspotUrl = `https://api.hubapi.com/crm/v3/objects/${encodeURIComponent(
      hubspotCustomObjectType
    )}/${encodeURIComponent(options.hubspotObjectId)}`;

    const response = await fetch(hubspotUrl, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${hubspotPrivateAppToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    hubspotResponse = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = hubspotResponse.message || `HubSpot returned ${response.status}`;
      throw new Error(message);
    }

    mode = "published";
  }

  const updatedRecord = await persistHubSpotPublishState(queryHash, {
    hubspotObjectId: options.hubspotObjectId,
    publishedAt,
  });

  return {
    mode,
    published: mode === "published",
    queryHash,
    projectNumber: record.projectNumber,
    security: toSecurityMetadata(updatedRecord || record),
    hubspotObjectId: options.hubspotObjectId,
    publishedAt,
    properties: payload.properties,
    hubspotResponse,
    message:
      mode === "published"
        ? "HubSpot custom object properties were updated."
        : "Publish payload saved locally. Configure HUBSPOT_PRIVATE_APP_TOKEN and HUBSPOT_CUSTOM_OBJECT_TYPE to enable direct HubSpot sync.",
  };
}

function buildHubSpotPropertyPayload(record, options) {
  return {
    properties: {
      cad_project_hash: record.queryHash,
      cad_viewer_url: buildPublicViewerUrl(options.request, record.queryHash),
      cad_project_number: record.projectNumber,
      cad_model_file_name: record.modelFileName,
      cad_hubspot_check_url: `${buildPublicBaseUrl(
        options.request
      )}/api/hubspot/model-summary?check=${encodeURIComponent(record.queryHash)}`,
      cad_authorization_key: record.hubspotAccessKey || "",
      cad_authorization_secret: options.accessSecret,
    },
  };
}

async function persistHubSpotPublishState(queryHash, state) {
  if (pool) {
    const result = await pool.query(
      `update viewer_links
       set hubspot_object_id = $1,
           hubspot_published_at = $2,
           updated_at = now()
       where query_hash = $3 and is_active = true
       returning ${viewerLinkSelectColumns()}`,
      [state.hubspotObjectId, state.publishedAt, queryHash]
    );
    const updated = result.rows[0] ? mapDbRecord(result.rows[0]) : null;
    if (updated && jsonBackupWriteEnabled) {
      await upsertFallbackLinkAccessBackup(updated.queryHash, {
        hubspotObjectId: updated.hubspotObjectId,
        hubspotPublishedAt: updated.hubspotPublishedAt,
      });
    }
    return updated;
  }

  const index = fallbackLinks.findIndex(
    (link) => link.queryHash === queryHash && link.isActive !== false
  );
  if (index === -1) return null;

  fallbackLinks[index] = {
    ...fallbackLinks[index],
    hubspotObjectId: state.hubspotObjectId,
    hubspotPublishedAt: state.publishedAt,
  };
  await persistFallbackLinks();
  return fallbackLinks[index];
}

async function upsertFallbackLinkAccessBackup(queryHash, state) {
  const index = fallbackLinks.findIndex(
    (link) => link.queryHash === queryHash && link.isActive !== false
  );
  if (index === -1) return null;

  fallbackLinks[index] = {
    ...fallbackLinks[index],
    ...Object.fromEntries(
      Object.entries(state).filter(([, value]) => value !== undefined)
    ),
  };
  await persistFallbackLinks();
  return fallbackLinks[index];
}

async function verifyViewerAccessCredentials(accessKey, accessSecret) {
  if (!accessKey || !accessSecret) return null;

  const record = await findViewerRecordByAccessKey(accessKey);
  if (!record?.hubspotAccessSecretHash) return null;

  const providedHash = hashSecret(accessSecret);
  return timingSafeEqual(providedHash, record.hubspotAccessSecretHash) ? record : null;
}

async function persistFallbackLinks() {
  const dataPath = path.join(__dirname, "data/viewer-links.json");
  await fs.promises.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.promises.writeFile(
    dataPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: "file-backed viewer link registry",
        links: fallbackLinks,
      },
      null,
      2
    )}\n`
  );
}

async function appendHubSpotWebhookEvent(event) {
  await fs.promises.mkdir(path.dirname(hubspotWebhookLogPath), { recursive: true });
  await fs.promises.appendFile(hubspotWebhookLogPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function readRecentHubSpotWebhookEvents(limit) {
  let content = "";
  try {
    content = await fs.promises.readFile(hubspotWebhookLogPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return content
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((line) => JSON.parse(line));
}

function captureCadViewerAccess(request, response, next) {
  const startedAt = Date.now();
  if (!shouldLogCadViewerAccess(request)) {
    next();
    return;
  }

  response.on("finish", () => {
    const event = buildCadViewerAccessEvent(request, response, startedAt);
    appendCadViewerAccessEvent(event).catch((error) => {
      console.error("cad viewer access log append failed", error);
    });
  });

  next();
}

function shouldLogCadViewerAccess(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  const pathname = request.path.replace(/\/+$/, "") || "/";
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/project-viewer" ||
    pathname === "/api/viewer-context" ||
    pathname === "/api/project-viewer-context" ||
    pathname === "/api/hubspot/model-summary" ||
    pathname.startsWith("/api/models/")
  );
}

function buildCadViewerAccessEvent(request, response, startedAt) {
  const userAgent = request.get("user-agent") || "";
  const client = classifyCadViewerClient(request, userAgent);
  const viewerAccess = response.locals.viewerAccess || {};

  return {
    id: crypto.randomUUID(),
    receivedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    method: request.method,
    path: request.path,
    originalUrl: redactUrl(request.originalUrl),
    statusCode: response.statusCode,
    contentLength: Number(response.getHeader("content-length")) || null,
    ip: getClientIp(request),
    forwardedFor: request.get("x-forwarded-for") || null,
    referrer: request.get("referer") || request.get("referrer") || null,
    origin: request.get("origin") || null,
    client,
    query: sanitizeAccessQuery(request.query || {}),
    viewer: {
      eventType: viewerAccess.eventType || inferViewerEventType(request),
      queryHash: viewerAccess.queryHash || null,
      projectNumber: viewerAccess.projectNumber || null,
      modelId: viewerAccess.modelId || null,
      modelFileName: viewerAccess.modelFileName || null,
      hubspotObjectId: viewerAccess.hubspotObjectId || null,
      available: viewerAccess.available ?? null,
      accessKeyRecognized: viewerAccess.accessKeyRecognized ?? null,
      fileSizeBytes: viewerAccess.fileSizeBytes ?? null,
      partCount: viewerAccess.partCount ?? null,
      componentCount: viewerAccess.componentCount ?? null,
    },
  };
}

function inferViewerEventType(request) {
  const pathname = request.path.replace(/\/+$/, "") || "/";
  if (pathname === "/" || pathname === "/index.html") return "viewer-page";
  if (pathname === "/project-viewer") return "project-viewer-page";
  if (pathname === "/api/viewer-context") return "viewer-context";
  if (pathname === "/api/project-viewer-context") return "project-viewer-context";
  if (pathname === "/api/hubspot/model-summary") return "hubspot-model-summary";
  if (pathname.endsWith("/glb")) return "model-download";
  if (pathname.endsWith("/catalog")) return "catalog-load";
  return "cad-viewer-access";
}

function classifyCadViewerClient(request, userAgent) {
  const ua = String(userAgent || "");
  const lower = ua.toLowerCase();
  const source = lower.includes("hubspot")
    ? "hubspot"
    : lower.includes("curl") || lower.includes("postman") || lower.includes("insomnia")
      ? "api-client"
      : request.path.startsWith("/api/")
        ? "browser-api"
        : "browser";

  return {
    source,
    userAgent: ua,
    browser: detectBrowser(ua),
    os: detectOperatingSystem(ua),
    device: detectDevice(ua),
    acceptsHtml: String(request.get("accept") || "").includes("text/html"),
  };
}

function detectBrowser(userAgent) {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/Chrome\//.test(userAgent) && !/Chromium\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) return "Safari";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Hubspot/i.test(userAgent)) return "HubSpot";
  if (/curl/i.test(userAgent)) return "curl";
  return "Unknown";
}

function detectOperatingSystem(userAgent) {
  if (/Windows NT/i.test(userAgent)) return "Windows";
  if (/Mac OS X/i.test(userAgent)) return "macOS";
  if (/Android/i.test(userAgent)) return "Android";
  if (/(iPhone|iPad|iPod)/i.test(userAgent)) return "iOS";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "Unknown";
}

function detectDevice(userAgent) {
  if (/Mobile|Android|iPhone|iPod/i.test(userAgent)) return "mobile";
  if (/iPad|Tablet/i.test(userAgent)) return "tablet";
  return "desktop";
}

function getClientIp(request) {
  const forwardedFor = request.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return request.ip || request.socket?.remoteAddress || null;
}

function sanitizeAccessQuery(query) {
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [key, sanitizeAccessQueryValue(key, value)])
  );
}

function sanitizeAccessQueryValue(key, value) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeAccessQueryValue(key, entry));
  const stringValue = String(value || "");
  const lowerKey = String(key || "").toLowerCase();
  const isSecretKey = [
    "token",
    "access_key",
    "c3_access_key",
    "cad_authorization_key",
  ].includes(lowerKey);

  if (isSecretKey || looksLikeAccessKey(stringValue)) {
    return fingerprintSecret(stringValue);
  }

  return stringValue;
}

function redactUrl(originalUrl) {
  const [pathname, queryString] = String(originalUrl || "").split("?");
  if (!queryString) return pathname;
  const params = new URLSearchParams(queryString);
  for (const key of [...params.keys()]) {
    const sanitized = sanitizeAccessQueryValue(key, params.get(key));
    params.set(key, typeof sanitized === "object" ? JSON.stringify(sanitized) : sanitized);
  }
  const redacted = params.toString();
  return redacted ? `${pathname}?${redacted}` : pathname;
}

function looksLikeAccessKey(value) {
  return /^c3_/i.test(value) || /^[a-f0-9]{40,}$/i.test(value);
}

function fingerprintSecret(value) {
  const raw = String(value || "");
  if (!raw) return "";
  return {
    redacted: true,
    last8: raw.slice(-8),
    sha256: crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16),
  };
}

async function appendCadViewerAccessEvent(event) {
  await fs.promises.mkdir(path.dirname(cadViewerAccessLogPath), { recursive: true });
  await fs.promises.appendFile(cadViewerAccessLogPath, `${JSON.stringify(event)}\n`, "utf8");
}

async function readRecentCadViewerAccessEvents(limit) {
  let content = "";
  try {
    content = await fs.promises.readFile(cadViewerAccessLogPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  return content
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((line) => JSON.parse(line));
}

function redactRequestHeaders(headers) {
  const sensitiveHeaders = new Set([
    "authorization",
    "cookie",
    "x-c3-authorization-secret",
    "x-hubspot-signature",
    "x-hubspot-signature-v3",
  ]);

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      sensitiveHeaders.has(key.toLowerCase()) ? "[redacted]" : value,
    ])
  );
}

function redactSecretFields(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactSecretFields);

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => {
      if (["token", "webhookToken", "webhook_token"].includes(key)) {
        return [key, "[redacted]"];
      }

      return [key, redactSecretFields(entryValue)];
    })
  );
}

function redactRawBodySecretFields(rawBody) {
  if (!rawBody) return "";

  try {
    return JSON.stringify(redactSecretFields(JSON.parse(rawBody)));
  } catch {
    return rawBody;
  }
}

function summarizeWebhookProperties(body) {
  const properties = getWebhookProperties(body);
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return {
      count: 0,
      keys: [],
    };
  }

  return {
    count: Object.keys(properties).length,
    keys: Object.keys(properties).sort(),
  };
}

function getWebhookProperties(body) {
  return body?.properties || body?.object?.properties || null;
}

function simplifyWebhookPropertyValues(body) {
  const properties = getWebhookProperties(body);
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};

  return Object.fromEntries(
    Object.entries(properties)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, property]) => [
        key,
        property && typeof property === "object" && "value" in property ? property.value : property,
      ])
  );
}

function toWebhookDashboardRow(event) {
  const values = simplifyWebhookPropertyValues(event.body);
  const serialNumberName =
    values.serial_number_name ||
    values.serial_number ||
    values.hs_object_source_detail_1 ||
    "";

  return {
    id: event.id,
    receivedAt: event.receivedAt,
    hubspotObjectId: String(event.body?.objectId || values.hs_object_id || ""),
    objectTypeId: event.body?.objectTypeId || "",
    version: event.body?.version ?? null,
    isDeleted: event.body?.isDeleted === true,
    projectId: values.projid || values.project_id || values.projectid || "",
    serialNumberName,
    explicitSerialNumberName: values.serial_number_name || "",
    sourceName: values.hs_object_source_detail_1 || "",
    sourceObjectId: values.hs_object_source_detail_2 || "",
    hubspotLastModifiedAt: values.hs_lastmodifieddate || "",
    hubspotCreatedAt: values.hs_createdate || "",
    ownerId: values.hubspot_owner_id || "",
    source: values.hs_object_source || "",
    propertyCount: Object.keys(values).length,
  };
}

function verifyReadOnlyWebhookToken(request) {
  return Boolean(
    hubspotWebhookToken && timingSafeEqual(getHubSpotWebhookToken(request), hubspotWebhookToken)
  );
}

function createViewerAccessCredentials(projectNumber) {
  const projectSlug = String(projectNumber || "project").replace(/[^a-zA-Z0-9]+/g, "").slice(0, 24);
  return {
    accessKey: `c3_${projectSlug}_${crypto.randomBytes(12).toString("base64url")}`,
    accessSecret: `c3s_${crypto.randomBytes(32).toString("base64url")}`,
  };
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

function requireAdminSession(request, response, next) {
  const session = readAdminSession(request);
  if (!session) {
    response.status(401).json({ authenticated: false, error: "Login required." });
    return;
  }

  request.adminSession = session;
  next();
}

function readAdminSession(request) {
  if (!adminSessionSecret) return null;

  const token = parseCookies(request.headers.cookie || "")[adminSessionCookie];
  if (!token) return null;

  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = crypto
    .createHmac("sha256", adminSessionSecret)
    .update(payload)
    .digest("base64url");

  if (!timingSafeEqual(signature, expected)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.user || Date.now() > Number(session.expiresAt)) return null;
    return session;
  } catch {
    return null;
  }
}

function createAdminSessionToken(session) {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", adminSessionSecret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter(Boolean)
      .map((cookie) => {
        const index = cookie.indexOf("=");
        if (index === -1) return [cookie, ""];
        return [
          decodeURIComponent(cookie.slice(0, index)),
          decodeURIComponent(cookie.slice(index + 1)),
        ];
      })
  );
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) parts.push(`Max-Age=${options.maxAge}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join("; ");
}

function verifyHubspotRequest(request, response, next) {
  const accessKey = request.get("x-c3-authorization-key");
  const accessSecret = request.get("x-c3-authorization-secret");
  const workflowAccessKey = accessSecret ? "" : getWorkflowAccessKey(request);
  Promise.resolve()
    .then(async () => {
      const workflowAccessRecord = workflowAccessKey
        ? await findWorkflowAccessRecordByAccessKey(workflowAccessKey)
        : null;
      if (workflowAccessRecord) {
        request.workflowAccessRecord = workflowAccessRecord;
        next();
        return;
      }

      if (workflowAccessKey && isExplicitWorkflowAccessKeyRequest(request)) {
        response.status(401).json({
          available: false,
          error: "Invalid C3 access key.",
        });
        return;
      }

      const queryWorkflowAccessKey = accessSecret ? "" : normalizeHash(request.query.q);
      if (queryWorkflowAccessKey) {
        const queryWorkflowAccessRecord =
          await findWorkflowAccessRecordByAccessKey(queryWorkflowAccessKey);
        if (queryWorkflowAccessRecord) {
          request.workflowAccessRecord = queryWorkflowAccessRecord;
          next();
          return;
        }
      }

      verifyHubspotRequestAfterWorkflowLookup(request, response, next, accessKey, accessSecret);
    })
    .catch((error) => {
      console.error("workflow access verification failed", error);
      response.status(500).json({
        available: false,
        error: "Unable to verify workflow access key.",
      });
    });
}

function verifyHubspotRequestAfterWorkflowLookup(
  request,
  response,
  next,
  accessKey,
  accessSecret
) {
  if (accessKey || accessSecret) {
    verifyViewerAccessCredentials(accessKey, accessSecret)
      .then((record) => {
        if (!record) {
          response.status(401).json({
            available: false,
            error: "Invalid project authorization credentials.",
          });
          return;
        }

        request.viewerAccessRecord = record;
        next();
      })
      .catch((error) => {
        console.error("project authorization failed", error);
        response.status(500).json({
          available: false,
          error: "Unable to verify project authorization credentials.",
        });
      });
    return;
  }

  if (!hubspotClientSecret) {
    if (isHubSpotWebhookCaptureRequest(request)) {
      verifyHubspotWebhookToken(request, response, next);
      return;
    }

    if (allowUnsignedHubspot) {
      request.hubspotSignatureSkipped = true;
      next();
      return;
    }

    response.status(503).json({
      available: false,
      error: "HubSpot signature validation is not configured.",
      summary: "Set HUBSPOT_CLIENT_SECRET before enabling this endpoint publicly.",
    });
    return;
  }

  const v3Signature = request.get("x-hubspot-signature-v3");
  const v2Signature = request.get("x-hubspot-signature");

  if (v3Signature) {
    verifyHubspotV3Signature(request, response, next, v3Signature);
    return;
  }

  if (v2Signature) {
    verifyHubspotV2Signature(request, response, next, v2Signature);
    return;
  }

  response.status(401).json({
    available: false,
    error: "Missing HubSpot signature headers.",
  });
}

function verifyHubspotV3Signature(request, response, next, signature) {
  const timestampHeader = request.get("x-hubspot-request-timestamp");
  const timestamp = Number(timestampHeader);

  if (!timestampHeader || !Number.isFinite(timestamp)) {
    response.status(401).json({
      available: false,
      error: "Missing HubSpot request timestamp header.",
    });
    return;
  }

  if (Math.abs(Date.now() - timestamp) > hubspotSignatureToleranceMs) {
    response.status(401).json({
      available: false,
      error: "HubSpot request timestamp is outside the allowed window.",
    });
    return;
  }

  const requestUri = buildOriginalRequestUri(request);
  const requestBody = request.rawBody || "";
  const signatureBase = `${request.method}${requestUri}${requestBody}${timestampHeader}`;
  const expectedSignature = crypto
    .createHmac("sha256", hubspotClientSecret)
    .update(signatureBase)
    .digest("base64");

  if (!timingSafeEqual(signature, expectedSignature)) {
    response.status(401).json({
      available: false,
      error: "Invalid HubSpot signature.",
    });
    return;
  }

  request.hubspotSignatureVerified = true;
  next();
}

function verifyHubspotV2Signature(request, response, next, signature) {
  const requestUri = buildOriginalRequestUri(request);
  const requestBody = request.rawBody || "";
  const signatureBase = `${hubspotClientSecret}${request.method}${requestUri}${requestBody}`;
  const expectedSignature = crypto.createHash("sha256").update(signatureBase).digest("hex");

  if (!timingSafeEqual(signature, expectedSignature)) {
    response.status(401).json({
      available: false,
      error: "Invalid HubSpot signature.",
    });
    return;
  }

  request.hubspotSignatureVerified = true;
  next();
}

function isHubSpotWebhookCaptureRequest(request) {
  return request.method === "POST" && request.path === "/api/hubspot/webhook";
}

function verifyHubspotWebhookToken(request, response, next) {
  if (!hubspotWebhookToken) {
    response.status(503).json({
      accepted: false,
      error: "HubSpot webhook token is not configured.",
      summary:
        "Set HUBSPOT_CLIENT_SECRET or HUBSPOT_WEBHOOK_TOKEN before enabling this endpoint publicly.",
    });
    return;
  }

  const providedToken = getHubSpotWebhookToken(request);

  if (!timingSafeEqual(providedToken, hubspotWebhookToken)) {
    response.status(401).json({
      accepted: false,
      error: "Invalid HubSpot webhook token.",
    });
    return;
  }

  request.hubspotSignatureSkipped = true;
  request.hubspotWebhookTokenVerified = true;
  next();
}

function getHubSpotWebhookToken(request) {
  const authorization = String(request.get("authorization") || "");
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);

  return String(
    request.get("x-c3-webhook-token") ||
      request.get("x-hubspot-webhook-token") ||
      request.get("wf-serial-creation-trigger-token") ||
      request.get("wf_serial_creation_trigger_token") ||
      request.get("hubspot-webhook-token") ||
      request.get("webhook-token") ||
      request.get("webhooktoken") ||
      request.get("token") ||
      bearerMatch?.[1] ||
      request.body?.webhookToken ||
      request.body?.token ||
      request.query.token ||
      ""
  ).trim();
}

function getWorkflowAccessKey(request) {
  return String(
    request.get("x-c3-access-key") ||
      request.get("x-c3-authorization-key") ||
      request.get("c3-access-key") ||
      request.get("c3_access_key") ||
      request.query.c3_access_key ||
      request.query.access_key ||
      request.query.cad_authorization_key ||
      ""
  ).trim();
}

function isExplicitWorkflowAccessKeyRequest(request) {
  return Boolean(
    request.get("x-c3-access-key") ||
      request.get("c3-access-key") ||
      request.get("c3_access_key") ||
      request.query.c3_access_key ||
      request.query.access_key ||
      request.query.cad_authorization_key
  );
}

function buildOriginalRequestUri(request) {
  const protocol = request.get("x-forwarded-proto") || request.protocol;
  const hostHeader = request.get("x-forwarded-host") || request.get("host");
  const prefix = request.get("x-forwarded-prefix") || "";
  return `${protocol}://${hostHeader}${prefix}${request.originalUrl}`;
}

function buildPublicViewerUrl(request, queryHash) {
  const baseUrl = buildPublicBaseUrl(request);
  return `${baseUrl}/?q=${encodeURIComponent(queryHash)}`;
}

function buildPublicBaseUrl(request) {
  return publicBaseUrl || buildRequestBaseUrl(request);
}

function buildRequestBaseUrl(request) {
  const protocol = request.get("x-forwarded-proto") || request.protocol;
  const hostHeader = request.get("x-forwarded-host") || request.get("host");
  const prefix = request.get("x-forwarded-prefix") || "";
  const basePath = prefix || "";
  return `${protocol}://${hostHeader}${basePath}`.replace(/\/$/, "");
}

function timingSafeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function checkDatabase() {
  try {
    await pool.query("select 1");
    return { configured: true, connected: true };
  } catch (error) {
    return { configured: true, connected: false, error: error.message };
  }
}

export function createQueryHash(projectNumber, modelFileName) {
  return crypto
    .createHash("sha256")
    .update(`${projectNumber}:${modelFileName}`)
    .digest("hex")
    .slice(0, 24);
}
