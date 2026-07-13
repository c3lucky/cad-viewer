export function normalizeViewerLinkForImport(link) {
  const publicModelId = String(link.id || "").trim();
  const queryHash = String(link.queryHash || "").trim();
  const projectNumber = String(link.projectNumber || "").trim();
  const modelFileName = String(link.modelFileName || "").trim();
  const modelName = String(link.modelName || modelFileName.replace(/\.glb$/i, "")).trim();
  const storagePath = String(link.storagePath || "").trim();

  if (!publicModelId || !queryHash || !projectNumber || !modelName || !modelFileName || !storagePath) {
    return {
      ok: false,
      error: "Missing required viewer link fields.",
      source: link,
    };
  }

  return {
    ok: true,
    value: {
      publicModelId,
      queryHash,
      projectNumber,
      modelName,
      modelFileName,
      storagePath,
      hubspotAccessKey: link.hubspotAccessKey || null,
      hubspotAccessSecretHash: link.hubspotAccessSecretHash || null,
      hubspotAccessSecretLast4: link.hubspotAccessSecretLast4 || null,
      hubspotAccessGeneratedAt: link.hubspotAccessGeneratedAt || null,
      hubspotAccessRotatedAt: link.hubspotAccessRotatedAt || null,
      hubspotObjectId: link.hubspotObjectId || null,
      hubspotPublishedAt: link.hubspotPublishedAt || null,
      isActive: link.isActive !== false,
    },
  };
}

export function normalizeWorkflowAccessForImport(record) {
  const projectNumber = String(record.projectNumber || "").trim();
  const accessKey = String(record.accessKey || "").trim();

  if (!projectNumber || !accessKey) {
    return {
      ok: false,
      error: "Missing required workflow access fields.",
      source: record,
    };
  }

  return {
    ok: true,
    value: {
      projectNumber,
      accessKey,
      hubspotObjectId: String(record.hubspotObjectId || "").trim() || null,
      objectTypeId: String(record.objectTypeId || "").trim() || null,
      serialNumberName: String(record.serialNumberName || "").trim() || null,
      mappedModelId: record.mappedModelId || null,
      queryHash: record.queryHash || null,
      modelFileName: record.modelFileName || null,
      viewerUrl: record.viewerUrl || null,
      hasMappedModel: record.hasMappedModel === true,
      firstSeenAt: record.firstSeenAt || null,
      lastSeenAt: record.lastSeenAt || null,
      lastWebhookEventId: record.lastWebhookEventId || null,
      isActive: record.isActive !== false,
    },
  };
}

export async function upsertViewerLink(pool, link) {
  const result = await pool.query(
    `insert into viewer_links
      (public_model_id, query_hash, project_number, model_name, model_file_name, storage_path,
       hubspot_access_key, hubspot_access_secret_hash, hubspot_access_secret_last4,
       hubspot_access_generated_at, hubspot_access_rotated_at, hubspot_object_id,
       hubspot_published_at, is_active)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (query_hash) do update set
       public_model_id = excluded.public_model_id,
       project_number = excluded.project_number,
       model_name = excluded.model_name,
       model_file_name = excluded.model_file_name,
       storage_path = excluded.storage_path,
       hubspot_access_key = excluded.hubspot_access_key,
       hubspot_access_secret_hash = excluded.hubspot_access_secret_hash,
       hubspot_access_secret_last4 = excluded.hubspot_access_secret_last4,
       hubspot_access_generated_at = excluded.hubspot_access_generated_at,
       hubspot_access_rotated_at = excluded.hubspot_access_rotated_at,
       hubspot_object_id = excluded.hubspot_object_id,
       hubspot_published_at = excluded.hubspot_published_at,
       is_active = excluded.is_active,
       updated_at = now()
     returning (xmax = 0) as inserted`,
    [
      link.publicModelId,
      link.queryHash,
      link.projectNumber,
      link.modelName,
      link.modelFileName,
      link.storagePath,
      link.hubspotAccessKey,
      link.hubspotAccessSecretHash,
      link.hubspotAccessSecretLast4,
      link.hubspotAccessGeneratedAt,
      link.hubspotAccessRotatedAt,
      link.hubspotObjectId,
      link.hubspotPublishedAt,
      link.isActive,
    ]
  );

  return result.rows[0]?.inserted ? "inserted" : "updated";
}

export async function upsertWorkflowAccess(pool, record) {
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
    [record.accessKey, record.hubspotObjectId, record.projectNumber]
  );

  const values = [
    record.projectNumber,
    record.accessKey,
    record.hubspotObjectId,
    record.objectTypeId,
    record.serialNumberName,
    record.mappedModelId,
    record.queryHash,
    record.modelFileName,
    record.viewerUrl,
    record.hasMappedModel,
    record.firstSeenAt,
    record.lastSeenAt,
    record.lastWebhookEventId,
    record.isActive,
  ];

  if (existing.rows[0]) {
    await pool.query(
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
           first_seen_at = $11,
           last_seen_at = $12,
           last_webhook_event_id = $13,
           is_active = $14,
           updated_at = now()
       where id = $15`,
      [...values, existing.rows[0].id]
    );
    return "updated";
  }

  await pool.query(
    `insert into hubspot_project_access
      (project_number, access_key, hubspot_object_id, object_type_id, serial_number_name,
       mapped_model_id, query_hash, model_file_name, viewer_url, has_mapped_model,
       first_seen_at, last_seen_at, last_webhook_event_id, is_active)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    values
  );
  return "inserted";
}
