import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const projectNumbers = (process.env.C3_PROJECTS || "")
  .split(",")
  .map((project) => project.trim())
  .filter(Boolean);
const shareRoot = path.resolve(process.env.C3_SHARE_ROOT || "/media/c3projectshare");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to seed viewer links.");
  process.exit(1);
}

if (!projectNumbers.length) {
  console.error("C3_PROJECTS is required, for example: C3_PROJECTS=226001,226022");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: parseSslMode(process.env.DATABASE_SSL),
});

let inserted = 0;

try {
  for (const projectNumber of projectNumbers) {
    const modelDir = path.join(
      shareRoot,
      projectNumber,
      "3. Build Drawings",
      "Mechanical",
      "E-Dwgs"
    );
    const files = await findGlbFiles(modelDir);

    for (const storagePath of files) {
      const modelFileName = path.basename(storagePath);
      const modelName = modelFileName.replace(/\.glb$/i, "");
      const queryHash = createQueryHash(projectNumber, modelFileName);

      await pool.query(
        `insert into viewer_links
          (public_model_id, query_hash, project_number, model_name, model_file_name, storage_path)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (query_hash) do update set
          public_model_id = excluded.public_model_id,
          project_number = excluded.project_number,
          model_name = excluded.model_name,
          model_file_name = excluded.model_file_name,
          storage_path = excluded.storage_path,
          is_active = true,
          updated_at = now()`,
        [`share-${projectNumber}-${slugify(modelName)}`, queryHash, projectNumber, modelName, modelFileName, storagePath]
      );

      inserted += 1;
      console.log(`${projectNumber} ${modelFileName} q=${queryHash}`);
    }
  }

  console.log(`Seeded ${inserted} viewer link(s).`);
} finally {
  await pool.end();
}

async function findGlbFiles(directory) {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".glb"))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function createQueryHash(projectNumber, modelFileName) {
  return crypto
    .createHash("sha256")
    .update(`${projectNumber}:${modelFileName}`)
    .digest("hex")
    .slice(0, 24);
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseSslMode(value) {
  if (!value || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return { rejectUnauthorized: true };
  if (value === "no-verify") return { rejectUnauthorized: false };
  return false;
}
