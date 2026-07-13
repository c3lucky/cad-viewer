import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectNumbers = getProjectNumbers();
const shareRoot = path.resolve(process.env.C3_SHARE_ROOT || "/media/c3projectshare");
const outputPath = path.resolve(
  process.env.C3_VIEWER_LINKS_PATH || path.join(__dirname, "../data/viewer-links.json")
);

const links = [];

for (const projectNumber of projectNumbers) {
  const modelDir = path.join(
    shareRoot,
    projectNumber,
    "3. Build Drawings",
    "Mechanical",
    "E-Dwgs"
  );
  const glbFiles = await findGlbFiles(modelDir);
  const easmFiles = await findEasmFiles(path.join(shareRoot, projectNumber));
  const preferredEasm = choosePreferredEasm(easmFiles, projectNumber);

  for (const storagePath of glbFiles) {
    const modelFileName = path.basename(storagePath);
    const modelName = modelFileName.replace(/\.glb$/i, "");
    const queryHash = createQueryHash(projectNumber, modelFileName);

    links.push({
      id: `share-${projectNumber}-${slugify(modelName)}`,
      queryHash,
      projectNumber,
      modelName,
      modelFileName,
      storagePath,
      metadataSource: preferredEasm ? toMetadataSource(preferredEasm) : null,
      isActive: true,
    });
  }
}

links.sort((a, b) => {
  const projectSort = a.projectNumber.localeCompare(b.projectNumber);
  if (projectSort !== 0) return projectSort;
  return a.modelFileName.localeCompare(b.modelFileName);
});

await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
await fs.promises.writeFile(
  outputPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      source: shareRoot,
      links,
    },
    null,
    2
  )}\n`
);

console.log(`Generated ${links.length} viewer link(s): ${outputPath}`);
for (const link of links) {
  console.log(`${link.projectNumber} ${link.modelFileName} q=${link.queryHash}`);
}

function getProjectNumbers() {
  const rawProjects =
    process.env.C3_PROJECTS ||
    "226001,226003,226007,226008,226009,226010,226022,226023,226024,226026,226027,226029";

  return rawProjects
    .split(",")
    .map((project) => project.trim())
    .filter(Boolean);
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

async function findEasmFiles(directory) {
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
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".easm")) {
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

function toMetadataSource(filePath) {
  return {
    type: "easm",
    fileName: path.basename(filePath),
    storagePath: filePath,
    relativePath: path.relative(shareRoot, filePath),
  };
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
