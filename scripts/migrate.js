import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "../db/schema.sql");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to run migrations.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: parseSslMode(process.env.DATABASE_SSL),
});

try {
  const schema = await fs.promises.readFile(schemaPath, "utf8");
  await pool.query(schema);
  console.log("Database migration completed.");
} finally {
  await pool.end();
}

function parseSslMode(value) {
  if (!value || value === "false" || value === "0") return false;
  if (value === "true" || value === "1") return { rejectUnauthorized: true };
  if (value === "no-verify") return { rejectUnauthorized: false };
  return false;
}
