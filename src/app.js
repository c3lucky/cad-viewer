import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

let MODEL_URLS = [
  "./models/226022-00_COMP.glb?v=20260617-comp",
  "./models/226022-00.glb?v=20260612-fallback",
];
let DATA_ENDPOINTS = {
  catalog: "./mock-api/catalog.json",
  inventory: "./mock-api/inventory.json",
  orderRequest: "./mock-api/order-request.json",
};
let viewerContext = {
  project: { number: "226022" },
  model: { name: "226022-00" },
};
const viewerContextEndpoint = window.CAD_VIEWER_CONTEXT_ENDPOINT || "api/viewer-context";

const viewer = document.querySelector("#viewer");
const drawer = document.querySelector("#drawer");
const resetButton = document.querySelector("#reset-view");
let viewerStatusBar = null;
let viewerStatusText = null;
let viewerStatusMeta = null;
let viewerStatusProgress = null;
let basketButton = null;
let hiddenPartsButton = null;
let viewerHint = null;
let checkoutPage = null;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
camera.position.set(240, 180, 260);

const renderer = new THREE.WebGLRenderer({
  alpha: true,
  antialias: false,
  powerPreference: "high-performance",
});
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewer.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xffffff, 0x6c7885, 2.2));

const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
keyLight.position.set(180, 260, 180);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xffffff, 0.85);
fillLight.position.set(-220, 120, -180);
scene.add(fillLight);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const pickableMeshes = [];
const originalMaterials = new Map();
const hiddenMeshes = new Set();
let selectedMesh = null;
let needsRender = true;
let partData = {
  catalogByPartNumber: new Map(),
  catalogByAlias: new Map(),
  inventoryBySku: new Map(),
  sources: [],
};
const collectionItems = [];
const c3PartNumberPattern = /(?:^|[^a-z0-9])((?:01|02|05|08|12|13|14|15|16)-\d{7})(?!\d)/i;

init();

async function init() {
  setupViewerStatusBar();
  setupBasketUi();
  updateViewerStatus({
    label: "Preparing 3D assembly",
    detail: "Initializing viewer",
    progress: 4,
    state: "loading",
  });
  showModelSkeleton("Preparing 3D assembly");
  renderDrawerSkeleton();
  resize();
  window.addEventListener("resize", () => {
    resize();
    requestRender();
  });
  window.addEventListener("hashchange", syncRoute);
  renderer.domElement.addEventListener("pointerdown", handlePick);
  renderer.domElement.addEventListener("contextmenu", handleHidePart);
  resetButton?.addEventListener("click", () => {
    frameScene();
    requestRender();
  });

  try {
    viewerContext = await loadViewerContext();
    partData = await loadPartData();
    await loadModel();
    if (!selectedMesh) renderEmptyDrawer();
  } catch (error) {
    console.error("Unable to initialize the viewer.", error);
    updateViewerStatus({
      label: "Unable to load CAD model",
      detail: error.message,
      progress: 100,
      state: "error",
    });
    showMessage(`Unable to load viewer data: ${error.message}`);
    renderDrawerError(error);
  }
  controls.addEventListener("change", requestRender);
  syncRoute();
  animate();
}

async function loadViewerContext() {
  const queryHash = new URLSearchParams(window.location.search).get("q")?.trim();
  if (!queryHash) return viewerContext;

  showModelSkeleton("Resolving project model");
  updateViewerStatus({
    label: "Resolving project model",
    detail: "Looking up viewer context",
    progress: 8,
    state: "loading",
  });

  const context = await fetchJson(`${viewerContextEndpoint}?q=${encodeURIComponent(queryHash)}`);
  if (!context?.model?.url) {
    throw new Error("Viewer context did not include a model URL.");
  }

  MODEL_URLS = [context.model.url];
  DATA_ENDPOINTS = {
    ...DATA_ENDPOINTS,
    ...(context.dataEndpoints || {}),
  };

  return context;
}

function requestRender() {
  needsRender = true;
}

async function loadPartData() {
  updateViewerStatus({
    label: "Loading part catalog",
    detail: "Reading EASM metadata and inventory",
    progress: 16,
    state: "loading",
  });
  const [catalog, inventory] = await Promise.all([
    fetchJson(DATA_ENDPOINTS.catalog),
    fetchJson(DATA_ENDPOINTS.inventory),
  ]);
  const parts = catalog.parts || [];

  return {
    catalogByPartNumber: new Map(parts.map((part) => [part.partNumber, part])),
    catalogByAlias: buildCatalogAliasMap(parts),
    inventoryBySku: new Map(
      (inventory.locations || []).map((item) => [item.sku, item])
    ),
    sources: [catalog.source, inventory.source].filter(Boolean),
  };
}

function buildCatalogAliasMap(parts) {
  const aliases = new Map();

  for (const part of parts) {
    for (const alias of getCatalogAliases(part)) {
      aliases.set(alias, part);
    }
  }

  return aliases;
}

function getCatalogAliases(part) {
  const occurrenceAliases = (part.occurrences || []).flatMap((occurrence) => [
    occurrence.name,
    occurrence.displayName,
    occurrence.path,
  ]);

  return [
    part.partNumber,
    part.sku,
    part.erpItemId,
    ...(part.aliases || []),
    ...occurrenceAliases,
  ].flatMap(getPartCandidates);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function loadModel() {
  showModelSkeleton("Loading 3D assembly");
  updateViewerStatus({
    label: "Loading 3D model",
    detail: viewerContext.model?.fileName || viewerContext.model?.name || "CAD model",
    progress: 22,
    state: "loading",
  });

  try {
    const gltf = await loadFirstAvailableModel();
    const model = gltf.scene;
    let meshCount = 0;

    model.traverse((node) => {
      if (!node.isMesh) return;
      meshCount += 1;

      node.castShadow = true;
      node.receiveShadow = true;
      node.userData.partNumber = getPartKey(node);
      pickableMeshes.push(node);
    });

    scene.add(model);
    clearMessage();
    frameScene();
    requestRender();
    updateViewerStatus({
      label: "Model ready",
      detail: getLoadedModelStatus(meshCount),
      progress: 100,
      state: "ready",
    });
  } catch (error) {
    console.error("Unable to load the 3D model.", error);
    showMessage(`Unable to load the 3D model: ${error.message}`);
    throw error;
  }
}

async function loadFirstAvailableModel() {
  const errors = [];
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(
    "https://unpkg.com/three@0.165.0/examples/jsm/libs/draco/"
  );

  for (const url of MODEL_URLS) {
    try {
      const loader = new GLTFLoader();
      loader.setDRACOLoader(dracoLoader);
      loader.setMeshoptDecoder(MeshoptDecoder);
      return await loadModelWithProgress(loader, url);
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
      console.warn(`Model load failed for ${url}`, error);
    }
  }

  throw new Error(errors.join("; "));
}

function loadModelWithProgress(loader, url) {
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      resolve,
      (event) => {
        const percent = getLoadPercent(event);
        updateViewerStatus({
          label: "Loading 3D model",
          detail: percent == null ? "Downloading model geometry" : `${formatBytes(event.loaded)} of ${formatBytes(event.total)}`,
          progress: percent == null ? 34 : 22 + percent * 0.7,
          state: "loading",
        });
      },
      reject
    );
  });
}

function getLoadPercent(event) {
  if (!event?.total) return null;
  return Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function getLoadedModelStatus(meshCount) {
  const projectNumber = viewerContext.project?.number || "Unknown project";
  const modelName =
    viewerContext.model?.fileName || viewerContext.model?.name || "CAD model";
  const catalogCount = partData.catalogByPartNumber?.size || 0;
  const catalogMessage = catalogCount
    ? `${catalogCount} catalog parts available`
    : "No EASM catalog metadata found";

  return `${projectNumber} • ${modelName} • ${meshCount} selectable meshes • ${catalogMessage}`;
}

function getPartKey(mesh) {
  const hierarchyPartNumber = getHierarchyPartNumber(mesh);
  if (hierarchyPartNumber) return hierarchyPartNumber;

  return (
    mesh.userData.partNumber ||
    mesh.userData.name ||
    mesh.name ||
    mesh.parent?.name ||
    "Unknown Part"
  );
}

function getHierarchyPartNumber(object) {
  let current = object;

  while (current) {
    const partNumber =
      getC3PartNumber(current.userData?.partNumber) ||
      getC3PartNumber(current.userData?.name) ||
      getC3PartNumber(current.name);

    if (partNumber) return partNumber;
    current = current.parent;
  }

  return "";
}

function getC3PartNumber(value) {
  return String(value || "").match(c3PartNumberPattern)?.[1]?.toUpperCase() || "";
}

function handlePick(event) {
  if (event.button !== 0) return;
  const mesh = getMeshFromPointer(event);
  if (!mesh) return;

  selectMesh(mesh);
}

function handleHidePart(event) {
  event.preventDefault();

  const mesh = getMeshFromPointer(event);
  if (!mesh) {
    showViewerHint("No part under cursor");
    return;
  }

  hideMesh(mesh);
}

function getMeshFromPointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster
    .intersectObjects(scene.children, true)
    .find((intersection) => isPickableIntersection(intersection.object));
  if (!hit) return null;

  return findPickableMesh(hit.object);
}

function isPickableIntersection(object) {
  const mesh = findPickableMesh(object);
  if (!mesh || hiddenMeshes.has(mesh) || !mesh.visible) return false;

  let current = mesh.parent;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }

  return true;
}

function findPickableMesh(object) {
  while (object && !object.isMesh) {
    object = object.parent;
  }

  if (!object || !object.isMesh) return null;
  if (!pickableMeshes.includes(object)) {
    pickableMeshes.push(object);
    object.userData.partNumber = getPartKey(object);
  }

  return object;
}

function selectMesh(mesh) {
  if (selectedMesh && originalMaterials.has(selectedMesh)) {
    selectedMesh.material = originalMaterials.get(selectedMesh);
  }

  selectedMesh = mesh;
  originalMaterials.set(mesh, mesh.material);
  mesh.material = mesh.material.clone();

  if ("color" in mesh.material) {
    mesh.material.color = new THREE.Color(0xff2a2a);
  }

  if ("emissive" in mesh.material) {
    mesh.material.emissive = new THREE.Color(0xff1f1f);
    mesh.material.emissiveIntensity = 0.45;
  }

  renderDrawer(mesh.userData.partNumber);
  requestRender();
}

function hideMesh(mesh) {
  if (selectedMesh === mesh) {
    restoreSelectedMaterial();
    selectedMesh = null;
    renderEmptyDrawer();
  }

  mesh.visible = false;
  hiddenMeshes.add(mesh);
  renderHiddenPartsButton();
  showViewerHint(`Hidden: ${getShortPartName(mesh.userData.partNumber)}`);
  requestRender();
}

function restoreHiddenMeshes() {
  hiddenMeshes.forEach((mesh) => {
    mesh.visible = true;
  });
  hiddenMeshes.clear();
  renderHiddenPartsButton();
  showViewerHint("Hidden parts restored");
  requestRender();
}

function restoreSelectedMaterial() {
  if (!selectedMesh || !originalMaterials.has(selectedMesh)) return;
  selectedMesh.material = originalMaterials.get(selectedMesh);
}

function getShortPartName(partNumber) {
  const candidates = getPartCandidates(partNumber);
  return candidates.at(-1) || partNumber || "part";
}

function renderDrawerSkeleton() {
  drawer.innerHTML = `
    <div class="drawer-body drawer-skeleton" aria-hidden="true">
      <span class="skeleton skeleton-chip"></span>
      <span class="skeleton skeleton-title"></span>
      <span class="skeleton skeleton-copy"></span>
      <span class="skeleton skeleton-copy short"></span>
      <div class="skeleton-status">
        <span class="skeleton skeleton-pill"></span>
        <span class="skeleton skeleton-pill"></span>
      </div>
      <div class="skeleton-grid">
        <span class="skeleton skeleton-row"></span>
        <span class="skeleton skeleton-row"></span>
        <span class="skeleton skeleton-row"></span>
        <span class="skeleton skeleton-row"></span>
        <span class="skeleton skeleton-row"></span>
      </div>
    </div>
    <footer class="drawer-footer drawer-footer-skeleton" aria-hidden="true">
      <span class="skeleton skeleton-button"></span>
      <span class="skeleton skeleton-button"></span>
    </footer>
  `;
}

function renderEmptyDrawer() {
  drawer.innerHTML = `
    <div class="drawer-empty">
      <div class="empty-mark" aria-hidden="true">
        <span></span>
        <span></span>
      </div>
      <p class="eyebrow">Part Details</p>
      <h2>Select a part</h2>
      <p>Click any component in the assembly to view part information and collect parts for a quote request.</p>
      <div class="empty-hints" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;
}

function renderDrawerError(error) {
  drawer.innerHTML = `
    <div class="drawer-empty">
      <p class="eyebrow">Details Unavailable</p>
      <h2>Unable to load part data</h2>
      <p>${escapeHtml(error.message)}</p>
    </div>
  `;
}

function renderDrawer(partNumber) {
  const catalog = resolveCatalog(partNumber);
  const inventory = partData.inventoryBySku.get(catalog.sku);
  const canCollect = catalog.orderable;
  const isCollected = collectionItems.some((item) => item.sku === catalog.sku);

  drawer.innerHTML = `
    <div class="drawer-body">
      <span class="part-number">${escapeHtml(catalog.partNumber)}</span>
      <h2>${escapeHtml(catalog.title || catalog.partNumber)}</h2>
      <p>${escapeHtml(catalog.description || "")}</p>

      <div class="status-strip">
        ${statusPill(catalog.orderable ? "Orderable" : "Contact support", catalog.orderable)}
        ${statusPill(inventory?.stockStatus || "Inventory unknown", Boolean(inventory))}
      </div>

      <div class="detail-list">
        ${detailRow("SKU / ERP item", catalog.sku || catalog.erpItemId)}
        ${detailRow("Revision", catalog.revision)}
        ${detailRow("Available quantity", inventory?.availableQuantity)}
        ${detailRow("Lead time", inventory ? `${inventory.leadTimeDays} days` : null)}
        ${detailRow("Warehouse", inventory?.warehouse)}
        ${detailRow("PDM file ID", catalog.pdmFileId)}
      </div>

      <section class="data-sources">
        <h3>Data pulled from</h3>
        ${partData.sources.map((source) => `<span>${escapeHtml(source)}</span>`).join("")}
      </section>
    </div>

    <footer class="drawer-footer collection-footer">
      <button id="collect-button" class="order-button" type="button" ${canCollect ? "" : "disabled"}>
        ${escapeHtml(isCollected ? "Add Another" : "Collect Part")}
      </button>
      <a href="#basket" class="basket-link">View Collection</a>
      <p class="order-note">${escapeHtml(getCollectionNote(catalog, inventory, isCollected))}</p>
    </footer>
  `;

  drawer.querySelector("#collect-button")?.addEventListener("click", () => {
    addCollectionItem(catalog, inventory);
    renderDrawer(catalog.partNumber);
  });
}

function resolveCatalog(partNumber) {
  if (partData.catalogByPartNumber.has(partNumber)) {
    return partData.catalogByPartNumber.get(partNumber);
  }

  const candidates = getPartCandidates(partNumber);
  for (const candidate of candidates) {
    if (partData.catalogByPartNumber.has(candidate)) {
      return partData.catalogByPartNumber.get(candidate);
    }
    if (partData.catalogByAlias.has(candidate)) {
      return partData.catalogByAlias.get(candidate);
    }
  }

  for (const catalog of partData.catalogByPartNumber.values()) {
    if (candidates.includes(catalog.sku) || candidates.includes(catalog.erpItemId)) {
      return catalog;
    }
  }

  return {
    partNumber,
    sku: partNumber,
    title: partNumber,
    description:
      "No catalog metadata matched this mesh name. This part may need review by the service team.",
    material: "TBD",
    finish: "TBD",
    quantityInAssembly: "TBD",
    orderable: false,
  };
}

function getPartCandidates(partNumber) {
  const segments = String(partNumber).split("/");
  const last = segments.at(-1) || partNumber;
  const beforeAt = last.split("@")[0] || last;
  const withoutAngleInstance = beforeAt.replace(/<\d+>/g, "");
  const withoutParenText = withoutAngleInstance.replace(/\([^)]*\)/g, "");
  const withoutInstance =
    (withoutParenText.match(/-/g) || []).length > 1
      ? withoutParenText.replace(/-\d+$/, "")
      : withoutParenText;
  const withoutConfig = withoutInstance.replace(/_.+$/, "");
  const exactC3PartNumber = getC3PartNumber(partNumber);
  const inferredPartNumber = withoutInstance.match(/\b(?:\d{2,6}|[A-Z]{2,}\d*)-\d{2,7}(?:-\d{1,4})?\b/i)?.[0];
  return [
    ...new Set(
      [
        exactC3PartNumber,
        partNumber,
        last,
        beforeAt,
        withoutAngleInstance,
        withoutParenText,
        withoutInstance,
        withoutConfig,
        inferredPartNumber,
      ].filter(Boolean)
    ),
  ];
}

function setupViewerStatusBar() {
  const workspace = document.querySelector(".workspace");
  if (!workspace || viewerStatusBar) return;

  viewerStatusBar = document.createElement("section");
  viewerStatusBar.className = "viewer-status-bar is-loading";
  viewerStatusBar.setAttribute("aria-label", "CAD model loading status");
  viewerStatusBar.innerHTML = `
    <div class="viewer-status-copy">
      <strong id="viewer-status-label">Preparing 3D assembly</strong>
      <span id="viewer-status-meta">Initializing viewer</span>
    </div>
    <div class="viewer-status-meter" aria-hidden="true">
      <span id="viewer-status-progress"></span>
    </div>
  `;

  viewer.after(viewerStatusBar);
  viewerStatusText = viewerStatusBar.querySelector("#viewer-status-label");
  viewerStatusMeta = viewerStatusBar.querySelector("#viewer-status-meta");
  viewerStatusProgress = viewerStatusBar.querySelector("#viewer-status-progress");
}

function updateViewerStatus({ label, detail, progress, state = "loading" }) {
  if (!viewerStatusBar) return;

  if (label && viewerStatusText) viewerStatusText.textContent = label;
  if (detail && viewerStatusMeta) viewerStatusMeta.textContent = detail;

  const normalizedProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  if (viewerStatusProgress) {
    viewerStatusProgress.style.width = `${normalizedProgress}%`;
  }

  viewerStatusBar.classList.toggle("is-loading", state === "loading");
  viewerStatusBar.classList.toggle("is-ready", state === "ready");
  viewerStatusBar.classList.toggle("is-error", state === "error");
}

function setupBasketUi() {
  const viewerTools = document.createElement("div");
  viewerTools.className = "viewer-tools";

  basketButton = document.createElement("a");
  basketButton.className = "basket-button";
  basketButton.href = "#basket";
  basketButton.textContent = "Collection";
  viewerTools.appendChild(basketButton);

  hiddenPartsButton = document.createElement("button");
  hiddenPartsButton.className = "hidden-parts-button";
  hiddenPartsButton.type = "button";
  hiddenPartsButton.addEventListener("click", restoreHiddenMeshes);
  viewerTools.appendChild(hiddenPartsButton);

  document.querySelector(".workspace")?.appendChild(viewerTools);

  viewerHint = document.createElement("div");
  viewerHint.className = "viewer-hint";
  viewerHint.setAttribute("role", "status");
  viewer.appendChild(viewerHint);

  checkoutPage = document.createElement("section");
  checkoutPage.className = "checkout-page";
  checkoutPage.setAttribute("aria-label", "Part collection and requests");
  document.body.appendChild(checkoutPage);
  renderBasketButton();
  renderHiddenPartsButton();
  renderCheckoutPage();
}

function addCollectionItem(catalog, inventory) {
  const key = catalog.sku || catalog.partNumber;
  const existing = collectionItems.find((item) => item.key === key);

  if (existing) {
    existing.quantity += 1;
    existing.updatedAt = new Date().toISOString();
  } else {
    collectionItems.push({
      key,
      assemblyId: viewerContext.model?.name || viewerContext.project?.number || "unknown",
      partNumber: catalog.partNumber,
      sku: catalog.sku,
      title: catalog.title || catalog.partNumber,
      quantity: 1,
      stockStatus: inventory?.stockStatus || "Inventory unknown",
      leadTimeDays: inventory?.leadTimeDays || null,
      updatedAt: new Date().toISOString(),
    });
  }

  renderBasketButton();
}

function removeCollectionItem(key) {
  const itemIndex = collectionItems.findIndex((item) => item.key === key);
  if (itemIndex === -1) return;

  const item = collectionItems[itemIndex];
  if (item.quantity > 1) {
    item.quantity -= 1;
    item.updatedAt = new Date().toISOString();
  } else {
    collectionItems.splice(itemIndex, 1);
  }

  renderBasketButton();
  renderCheckoutPage();
  if (selectedMesh) renderDrawer(selectedMesh.userData.partNumber);
}

function updateCollectionQuantity(key, rawQuantity) {
  const itemIndex = collectionItems.findIndex((item) => item.key === key);
  if (itemIndex === -1) return;

  const quantity = Math.max(1, Math.floor(Number(rawQuantity) || 1));
  collectionItems[itemIndex].quantity = quantity;
  collectionItems[itemIndex].updatedAt = new Date().toISOString();
  renderBasketButton();
  updateCollectionTotals();
  if (selectedMesh) renderDrawer(selectedMesh.userData.partNumber);
}

function updateCollectionTotals() {
  const totalPieces = collectionItems.reduce((total, item) => total + item.quantity, 0);
  const totalPiecesNode = checkoutPage?.querySelector("#total-pieces");
  if (totalPiecesNode) totalPiecesNode.textContent = String(totalPieces);
}

function renderBasketButton() {
  if (!basketButton) return;

  const count = collectionItems.reduce((total, item) => total + item.quantity, 0);
  basketButton.innerHTML = `
    <span>Collection</span>
    <strong>${escapeHtml(count)}</strong>
  `;
}

function renderHiddenPartsButton() {
  if (!hiddenPartsButton) return;

  const count = hiddenMeshes.size;
  hiddenPartsButton.hidden = count === 0;
  hiddenPartsButton.innerHTML = `
    <span>Show Hidden</span>
    <strong>${escapeHtml(count)}</strong>
  `;
}

function showViewerHint(message) {
  if (!viewerHint) return;

  viewerHint.textContent = message;
  viewerHint.classList.add("is-visible");
  window.clearTimeout(showViewerHint.timeoutId);
  showViewerHint.timeoutId = window.setTimeout(() => {
    viewerHint?.classList.remove("is-visible");
  }, 1800);
}

function syncRoute() {
  const isBasket = window.location.hash === "#basket";
  document.body.classList.toggle("show-checkout", isBasket);
  if (isBasket) renderCheckoutPage();
}

function renderCheckoutPage() {
  if (!checkoutPage) return;
  const totalPieces = collectionItems.reduce((total, item) => total + item.quantity, 0);

  checkoutPage.innerHTML = `
    <div class="checkout-shell">
      <header class="checkout-header">
        <div>
          <p class="eyebrow">Collection</p>
          <h1>Collected Parts</h1>
        </div>
        <a href="#" class="text-button">Back To Viewer</a>
      </header>

      ${
        collectionItems.length
          ? `
            <div class="checkout-layout">
              <div class="checkout-main-column">
                ${basketSection("Parts To Request", collectionItems)}

                <section class="checkout-summary">
                  <div>
                    <span>Unique parts</span>
                    <strong>${escapeHtml(collectionItems.length)}</strong>
                  </div>
                  <div>
                    <span>Total pieces</span>
                    <strong id="total-pieces">${escapeHtml(totalPieces)}</strong>
                  </div>
                  <div>
                    <span>Pricing</span>
                    <strong>Provided by quote</strong>
                  </div>
                </section>
              </div>

              <aside class="checkout-side-column">
                <section class="quote-delivery">
                  <div>
                    <p class="eyebrow">Next Step</p>
                    <h2>Request quote</h2>
                    <p>Collected parts will be prepared for a HubSpot quote after portal setup is complete.</p>
                  </div>
                  <div class="quote-action-row">
                    <button id="request-quote" class="quote-button" type="button">Request Quote</button>
                  </div>
                  <p id="request-status" class="order-note">Collected parts will be packaged with item details, quantities, availability, and lead times.</p>
                </section>

                <section class="checkout-actions">
                  <button id="clear-basket" type="button">Clear Collection</button>
                </section>
              </aside>
            </div>
          `
          : `
            <section class="empty-basket">
              <p class="eyebrow">No Lines Added</p>
              <h2>Select parts in the CAD viewer, then collect them for quote.</h2>
              <a href="#" class="order-button">Return To Viewer</a>
            </section>
          `
      }
    </div>
  `;

  checkoutPage.querySelector("#request-quote")?.addEventListener("click", () => {
    submitQuoteRequest();
  });

  checkoutPage.querySelector("#clear-basket")?.addEventListener("click", () => {
    collectionItems.length = 0;
    renderBasketButton();
    renderCheckoutPage();
  });

  checkoutPage.querySelectorAll("[data-remove-key]").forEach((button) => {
    button.addEventListener("click", () => {
      removeCollectionItem(button.dataset.removeKey);
    });
  });

  checkoutPage.querySelectorAll("[data-quantity-key]").forEach((input) => {
    input.addEventListener("input", () => {
      updateCollectionQuantity(input.dataset.quantityKey, input.value);
    });
    input.addEventListener("change", () => {
      input.value = String(Math.max(1, Math.floor(Number(input.value) || 1)));
    });
  });
}

async function submitQuoteRequest() {
  const status = checkoutPage.querySelector("#request-status");
  const button = checkoutPage.querySelector("#request-quote");
  const payload = createCollectionPayload("quote");
  setRequestLoading(button, true, "Submitting");
  setRequestStatus(status, "Submitting quote request...", "pending");

  await waitForMockResponse();
  console.info("quote request payload", payload);
  setRequestStatus(
    status,
    `Quote request ${payload.requestNumber} prepared for HubSpot quote creation.`,
    "success"
  );
  setRequestLoading(button, false);
}

function setRequestLoading(button, isLoading, label = "Submitting") {
  if (!button) return;
  if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent.trim();

  button.disabled = isLoading;
  button.classList.toggle("is-loading", isLoading);
  button.innerHTML = isLoading
    ? `<span class="button-spinner" aria-hidden="true"></span>${escapeHtml(label)}`
    : escapeHtml(button.dataset.defaultLabel);
}

function setRequestStatus(status, message, tone) {
  if (!status) return;
  status.classList.remove("success", "error", "pending");
  status.classList.add(tone);
  status.textContent = message;
}

function waitForMockResponse() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 450);
  });
}

function createCollectionPayload(requestKind) {
  return {
    requestKind,
    assemblyId: viewerContext.model?.name || viewerContext.project?.number || "unknown",
    projectNumber: viewerContext.project?.number || null,
    requestNumber: createRequestNumber(requestKind),
    lines: collectionItems.map(toCheckoutLine),
  };
}

function basketSection(title, items) {
  return `
    <section class="basket-section">
      <header>
        <div>
          <p class="eyebrow">Review</p>
          <h2>${escapeHtml(title)}</h2>
        </div>
        <strong>${escapeHtml(items.length)} lines</strong>
      </header>
      ${
        items.length
          ? `
            <div class="basket-table-wrap">
              <table class="basket-table">
                <thead>
                  <tr>
                    <th scope="col">Part</th>
                    <th scope="col">SKU</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Lead</th>
                    <th scope="col">Status</th>
                    <th scope="col"><span class="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  ${items.map(basketItem).join("")}
                </tbody>
              </table>
            </div>
          `
          : `<p class="empty-section">No ${escapeHtml(title.toLowerCase())} yet.</p>`
      }
    </section>
  `;
}

function basketItem(item) {
  return `
    <tr>
      <td>
        <strong>${escapeHtml(item.title)}</strong>
        <span>${escapeHtml(item.partNumber)}</span>
      </td>
      <td><code>${escapeHtml(item.sku)}</code></td>
      <td>
        <input
          class="quantity-input"
          type="number"
          min="1"
          step="1"
          value="${escapeHtml(item.quantity)}"
          data-quantity-key="${escapeHtml(item.key)}"
          aria-label="Quantity for ${escapeHtml(item.title)}"
        />
      </td>
      <td>${escapeHtml(item.leadTimeDays ? `${item.leadTimeDays} days` : "TBD")}</td>
      <td><span class="table-status">${escapeHtml(item.stockStatus)}</span></td>
      <td>
        <button class="remove-line-button" type="button" data-remove-key="${escapeHtml(item.key)}" aria-label="Remove ${escapeHtml(item.title)}">
          &times;
        </button>
      </td>
    </tr>
  `;
}

function toCheckoutLine(item) {
  return {
    assemblyId: item.assemblyId,
    partNumber: item.partNumber,
    sku: item.sku,
    quantity: item.quantity,
    stockStatus: item.stockStatus,
    leadTimeDays: item.leadTimeDays,
  };
}

function createRequestNumber(requestKind) {
  const stamp = new Date()
    .toISOString()
    .slice(2, 10)
    .replaceAll("-", "");
  const prefix = requestKind === "quote" ? "Q" : "O";
  return `${prefix}-${stamp}-${String(collectionItems.length).padStart(3, "0")}`;
}

function statusPill(label, positive) {
  return `<span class="status-pill ${positive ? "positive" : "neutral"}">${escapeHtml(label)}</span>`;
}

function getCollectionNote(catalog, inventory, isCollected) {
  if (!catalog.orderable) return "This item is marked non-orderable in PDM/CAD metadata.";
  if (!inventory) return "No inventory record was returned for this SKU. It can still be reviewed by sales.";
  if (isCollected) return "This part is already in the collection. Add another if more than one is needed.";

  return "Ready to collect. Pricing will be handled during quote review.";
}

function detailRow(label, value) {
  if (!value) return "";

  return `
    <div class="detail-row">
      <div class="detail-label">${escapeHtml(label)}</div>
      <div class="detail-value">${escapeHtml(String(value))}</div>
    </div>
  `;
}

function frameScene() {
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) return;

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.75 || 100;

  camera.position.copy(center).add(new THREE.Vector3(radius, radius * 0.7, radius));
  camera.near = Math.max(radius / 1000, 0.1);
  camera.far = radius * 20;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

function resize() {
  const { clientWidth, clientHeight } = viewer;
  camera.aspect = clientWidth / Math.max(clientHeight, 1);
  camera.updateProjectionMatrix();
  renderer.setSize(clientWidth, clientHeight, false);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  if (!needsRender) return;
  renderer.render(scene, camera);
  needsRender = false;
}

function showMessage(text) {
  clearMessage();
  const message = document.createElement("div");
  message.className = "viewer-message";
  message.innerHTML = `<div>${escapeHtml(text)}</div>`;
  viewer.appendChild(message);
}

function showModelSkeleton(label) {
  clearMessage();
  const message = document.createElement("div");
  message.className = "viewer-message viewer-loading";
  message.innerHTML = `
    <div class="model-skeleton">
      <div class="model-skeleton-stage" aria-hidden="true">
        <span class="model-axis x"></span>
        <span class="model-axis y"></span>
        <span class="model-part part-a"></span>
        <span class="model-part part-b"></span>
        <span class="model-part part-c"></span>
        <span class="model-part part-d"></span>
      </div>
      <div class="model-loading-copy">
        <span class="skeleton skeleton-chip"></span>
        <strong>${escapeHtml(label)}</strong>
        <span class="skeleton skeleton-copy"></span>
      </div>
    </div>
  `;
  viewer.appendChild(message);
}

function clearMessage() {
  viewer.querySelector(".viewer-message")?.remove();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
