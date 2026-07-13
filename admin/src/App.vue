<script setup>
import { computed, onMounted, ref } from "vue";
import {
  CheckCircle2,
  Copy,
  Database,
  ExternalLink,
  FileBox,
  Link2,
  LogOut,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "@lucide/vue";

const apiBase = "/cad-viewer/api/admin";

const session = ref({ authenticated: false, user: null });
const health = ref(null);
const links = ref([]);
const workflowAccessRecords = ref([]);
const generatedAt = ref(null);
const loading = ref(true);
const loginLoading = ref(false);
const error = ref("");
const copied = ref("");
const filter = ref("");
const selectedHubSpotLink = ref(null);
const accessCredentialResult = ref(null);
const accessCredentialLoading = ref(false);
const publishLoading = ref(false);
const publishStatus = ref(null);
const credentials = ref({
  username: "admin",
  password: "",
});

const filteredLinks = computed(() => {
  const value = filter.value.trim().toLowerCase();
  if (!value) return links.value;
  return links.value.filter((link) =>
    [link.projectNumber, link.modelFileName, link.queryHash]
      .join(" ")
      .toLowerCase()
      .includes(value)
  );
});

const readableCount = computed(() => links.value.filter((link) => link.readable).length);
const workflowAccessCount = computed(() => workflowAccessRecords.value.length);
const totalSizeMb = computed(() =>
  links.value.reduce((total, link) => total + Number(link.fileSizeMb || 0), 0).toFixed(2)
);
const hubspotProperties = [
  {
    name: "cad_project_hash",
    label: "CAD Project Hash",
    type: "Single-line text",
    required: true,
  },
  {
    name: "cad_viewer_url",
    label: "CAD Viewer URL",
    type: "URL or Single-line text",
    required: true,
  },
  {
    name: "cad_project_number",
    label: "CAD Project Number",
    type: "Single-line text",
    required: false,
  },
  {
    name: "cad_model_file_name",
    label: "CAD Model File Name",
    type: "Single-line text",
    required: false,
  },
  {
    name: "cad_hubspot_check_url",
    label: "CAD HubSpot Check URL",
    type: "URL or Single-line text",
    required: false,
  },
  {
    name: "cad_authorization_key",
    label: "CAD Authorization Key",
    type: "Single-line text",
    required: false,
  },
  {
    name: "cad_authorization_secret",
    label: "CAD Authorization Secret",
    type: "Sensitive single-line text",
    required: false,
  },
];

onMounted(async () => {
  await loadSession();
});

async function loadSession() {
  loading.value = true;
  error.value = "";
  try {
    session.value = await api("/session");
    if (session.value.authenticated) await loadDashboard();
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

async function login() {
  loginLoading.value = true;
  error.value = "";
  try {
    session.value = await api("/login", {
      method: "POST",
      body: JSON.stringify(credentials.value),
    });
    credentials.value.password = "";
    await loadDashboard();
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loginLoading.value = false;
  }
}

async function logout() {
  await api("/logout", { method: "POST" });
  session.value = { authenticated: false, user: null };
  health.value = null;
  links.value = [];
}

async function loadDashboard() {
  error.value = "";
  const [healthResult, linksResult] = await Promise.all([
    api("/health"),
    api("/viewer-links"),
  ]);
  health.value = healthResult;
  links.value = linksResult.links || [];
  workflowAccessRecords.value = linksResult.workflowAccessRecords || [];
  generatedAt.value = linksResult.generatedAt;
}

async function copyText(value, label) {
  await navigator.clipboard.writeText(value);
  copied.value = label;
  window.setTimeout(() => {
    if (copied.value === label) copied.value = "";
  }, 1400);
}

function createHubSpotPropertyPayload(link) {
  return [
    `cad_project_hash=${link.queryHash}`,
    `cad_viewer_url=${link.viewerUrl}`,
    `cad_project_number=${link.projectNumber}`,
    `cad_model_file_name=${link.modelFileName}`,
    `cad_hubspot_check_url=${link.hubspotCheckUrl}`,
    `cad_authorization_key=${link.security?.hubspotAccessKey || ""}`,
  ].join("\n");
}

function createHubSpotJsonPayload(link) {
  return JSON.stringify(
    {
      properties: {
        cad_project_hash: link.queryHash,
        cad_viewer_url: link.viewerUrl,
        cad_project_number: link.projectNumber,
        cad_model_file_name: link.modelFileName,
        cad_hubspot_check_url: link.hubspotCheckUrl,
        cad_authorization_key: link.security?.hubspotAccessKey || "",
      },
    },
    null,
    2
  );
}

function openHubSpotDrawer(link) {
  selectedHubSpotLink.value = link;
  publishStatus.value = null;
  accessCredentialResult.value = null;
}

function closeHubSpotDrawer() {
  selectedHubSpotLink.value = null;
  accessCredentialResult.value = null;
  publishStatus.value = null;
}

async function rotateAccessCredentials(link) {
  accessCredentialLoading.value = true;
  error.value = "";

  try {
    const result = await api(
      `/viewer-links/${encodeURIComponent(link.queryHash)}/access-credentials`,
      { method: "POST" }
    );
    accessCredentialResult.value = result;
    selectedHubSpotLink.value = {
      ...selectedHubSpotLink.value,
      security: result.security,
    };
    links.value = links.value.map((item) =>
      item.queryHash === link.queryHash ? { ...item, security: result.security } : item
    );
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    accessCredentialLoading.value = false;
  }
}

async function publishHubSpotProperties(link) {
  publishLoading.value = true;
  publishStatus.value = null;
  error.value = "";

  try {
    const result = await api(`/viewer-links/${encodeURIComponent(link.queryHash)}/publish-hubspot`, {
      method: "POST",
      body: JSON.stringify({
        accessSecret: accessCredentialResult.value?.accessSecret || "",
      }),
    });

    publishStatus.value = result;
    selectedHubSpotLink.value = {
      ...selectedHubSpotLink.value,
      security: result.security,
    };
    links.value = links.value.map((item) =>
      item.queryHash === link.queryHash ? { ...item, security: result.security } : item
    );
  } catch (requestError) {
    publishStatus.value = {
      published: false,
      message: requestError.message,
      error: true,
    };
  } finally {
    publishLoading.value = false;
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    credentials: "same-origin",
    ...options,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}
</script>

<template>
  <main class="min-h-screen bg-canvas text-ink">
    <section
      v-if="loading"
      class="grid min-h-screen place-items-center px-6 text-sm font-semibold text-muted"
    >
      Loading admin console
    </section>

    <section v-else-if="!session.authenticated" class="grid min-h-screen place-items-center px-6">
      <form
        class="w-full max-w-sm rounded-lg border border-line bg-panel p-6 shadow-sm"
        @submit.prevent="login"
      >
        <div class="mb-6">
          <div
            class="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-md bg-slate-900 text-white"
          >
            <ShieldCheck :size="21" />
          </div>
          <h1 class="text-2xl font-bold tracking-normal">CAD Viewer Admin</h1>
          <p class="mt-2 text-sm text-muted">Sign in to manage project viewer links.</p>
        </div>

        <label class="mb-2 block text-sm font-bold" for="username">Username</label>
        <input
          id="username"
          v-model="credentials.username"
          class="mb-4 min-h-10 w-full rounded-md border border-line bg-white px-3"
          autocomplete="username"
        />

        <label class="mb-2 block text-sm font-bold" for="password">Password</label>
        <input
          id="password"
          v-model="credentials.password"
          class="mb-4 min-h-10 w-full rounded-md border border-line bg-white px-3"
          type="password"
          autocomplete="current-password"
        />

        <p v-if="error" class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {{ error }}
        </p>

        <button
          class="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 font-bold text-white hover:bg-slate-800 disabled:opacity-60"
          type="submit"
          :disabled="loginLoading"
        >
          <ShieldCheck :size="18" />
          {{ loginLoading ? "Signing in" : "Sign in" }}
        </button>
      </form>
    </section>

    <section v-else class="mx-auto w-[min(1220px,calc(100vw-32px))] py-6">
      <header class="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p class="text-xs font-extrabold uppercase text-muted">C3 Admin</p>
          <h1 class="mt-1 text-3xl font-bold tracking-normal">CAD Viewer Links</h1>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            class="inline-flex min-h-10 items-center gap-2 rounded-md border border-line bg-white px-3 font-bold hover:bg-slate-50"
            type="button"
            @click="loadDashboard"
          >
            <RefreshCw :size="17" />
            Refresh
          </button>
          <button
            class="inline-flex min-h-10 items-center gap-2 rounded-md border border-line bg-white px-3 font-bold hover:bg-slate-50"
            type="button"
            @click="logout"
          >
            <LogOut :size="17" />
            Sign out
          </button>
        </div>
      </header>

      <p v-if="error" class="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
        {{ error }}
      </p>

      <div class="mb-5 grid gap-3 md:grid-cols-5">
        <section class="rounded-lg border border-line bg-white p-4">
          <FileBox class="mb-3 text-accent" :size="22" />
          <p class="text-sm font-bold text-muted">Mapped Models</p>
          <strong class="mt-1 block text-2xl">{{ links.length }}</strong>
        </section>
        <section class="rounded-lg border border-line bg-white p-4">
          <CheckCircle2 class="mb-3 text-emerald-600" :size="22" />
          <p class="text-sm font-bold text-muted">Readable</p>
          <strong class="mt-1 block text-2xl">{{ readableCount }}</strong>
        </section>
        <section class="rounded-lg border border-line bg-white p-4">
          <Database class="mb-3 text-slate-700" :size="22" />
          <p class="text-sm font-bold text-muted">Database</p>
          <strong class="mt-1 block text-lg">
            {{ health?.database?.configured ? "Configured" : "Mapping file" }}
          </strong>
        </section>
        <section class="rounded-lg border border-line bg-white p-4">
          <FileBox class="mb-3 text-indigo-700" :size="22" />
          <p class="text-sm font-bold text-muted">Total GLB Size</p>
          <strong class="mt-1 block text-2xl">{{ totalSizeMb }} MB</strong>
        </section>
        <section class="rounded-lg border border-line bg-white p-4">
          <ShieldCheck class="mb-3 text-emerald-700" :size="22" />
          <p class="text-sm font-bold text-muted">C3 Access Records</p>
          <strong class="mt-1 block text-2xl">{{ workflowAccessCount }}</strong>
        </section>
      </div>

      <section class="mb-5 rounded-lg border border-line bg-white p-4">
        <div class="mb-3 flex items-center gap-2">
          <ShieldCheck class="text-emerald-700" :size="20" />
          <h2 class="text-lg font-bold">Workflow Access Records</h2>
        </div>
        <div v-if="workflowAccessRecords.length" class="overflow-x-auto rounded-md border border-line">
          <table class="min-w-[980px] w-full border-collapse text-left text-sm">
            <thead class="bg-slate-50 text-xs uppercase text-muted">
              <tr>
                <th class="border-b border-line px-3 py-3">Project</th>
                <th class="border-b border-line px-3 py-3">Serial</th>
                <th class="border-b border-line px-3 py-3">HubSpot Object</th>
                <th class="border-b border-line px-3 py-3">Access Key</th>
                <th class="border-b border-line px-3 py-3">Model</th>
                <th class="border-b border-line px-3 py-3">Last Seen</th>
                <th class="border-b border-line px-3 py-3">Viewer</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="record in workflowAccessRecords" :key="`${record.projectNumber}-${record.hubspotObjectId}`">
                <td class="border-b border-line px-3 py-3 font-bold">{{ record.projectNumber }}</td>
                <td class="border-b border-line px-3 py-3">{{ record.serialNumberName || "Unknown" }}</td>
                <td class="border-b border-line px-3 py-3">
                  <code class="rounded bg-slate-100 px-1.5 py-1 text-xs">{{ record.hubspotObjectId || "Unknown" }}</code>
                </td>
                <td class="border-b border-line px-3 py-3">
                  <span class="rounded bg-slate-100 px-1.5 py-1 text-xs font-bold">
                    {{ record.hasAccessKey ? `•••• ${record.accessKeyLast8}` : "Missing" }}
                  </span>
                </td>
                <td class="border-b border-line px-3 py-3">
                  <span
                    class="inline-flex rounded-full px-2 py-1 text-xs font-extrabold"
                    :class="record.hasMappedModel ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'"
                  >
                    {{ record.hasMappedModel ? record.modelFileName : "No mapped model" }}
                  </span>
                </td>
                <td class="border-b border-line px-3 py-3">{{ record.lastSeenAt || "Unknown" }}</td>
                <td class="border-b border-line px-3 py-3">
                  <a
                    v-if="record.viewerUrl"
                    class="text-accent hover:underline"
                    :href="record.viewerUrl"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open
                  </a>
                  <span v-else class="text-muted">Unavailable</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="rounded-md bg-slate-50 px-3 py-2 text-sm text-muted">
          No workflow access records have been received yet.
        </p>
      </section>

      <section class="mb-5 rounded-lg border border-line bg-white p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 class="text-lg font-bold">Link Map</h2>
            <p class="text-sm text-muted">Generated {{ generatedAt || "unknown" }}</p>
          </div>
          <label class="relative block w-full max-w-sm">
            <Search class="absolute left-3 top-1/2 -translate-y-1/2 text-muted" :size="17" />
            <input
              v-model="filter"
              class="min-h-10 w-full rounded-md border border-line bg-white pl-9 pr-3"
              type="search"
              placeholder="Search project, model, or hash"
            />
          </label>
        </div>
      </section>

      <section class="mb-5 rounded-lg border border-line bg-white p-4">
        <div class="mb-3 flex items-center gap-2">
          <Link2 class="text-accent" :size="20" />
          <h2 class="text-lg font-bold">HubSpot Custom Object Properties</h2>
        </div>
        <div class="grid gap-2 md:grid-cols-5">
          <div
            v-for="property in hubspotProperties"
            :key="property.name"
            class="rounded-md border border-line bg-slate-50 p-3"
          >
            <p class="text-xs font-extrabold uppercase text-muted">{{ property.label }}</p>
            <code class="mt-2 block rounded bg-white px-2 py-1 text-xs">{{ property.name }}</code>
            <p class="mt-2 text-xs text-muted">{{ property.type }}</p>
            <p class="mt-1 text-xs font-bold" :class="property.required ? 'text-red-700' : 'text-muted'">
              {{ property.required ? "Required" : "Optional" }}
            </p>
          </div>
        </div>
      </section>

      <div class="overflow-x-auto rounded-lg border border-line bg-white">
        <table class="min-w-[1080px] w-full border-collapse text-left text-sm">
          <thead class="bg-slate-50 text-xs uppercase text-muted">
            <tr>
              <th class="border-b border-line px-3 py-3">Project</th>
              <th class="border-b border-line px-3 py-3">Model</th>
              <th class="border-b border-line px-3 py-3">Hash</th>
              <th class="border-b border-line px-3 py-3">Size</th>
              <th class="border-b border-line px-3 py-3">Status</th>
              <th class="border-b border-line px-3 py-3">Viewer URL</th>
              <th class="border-b border-line px-3 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="link in filteredLinks" :key="link.queryHash">
              <td class="border-b border-line px-3 py-3 font-bold">{{ link.projectNumber }}</td>
              <td class="border-b border-line px-3 py-3">{{ link.modelFileName }}</td>
              <td class="border-b border-line px-3 py-3">
                <code class="rounded bg-slate-100 px-1.5 py-1 text-xs">{{ link.queryHash }}</code>
              </td>
              <td class="border-b border-line px-3 py-3">
                {{ link.fileSizeMb == null ? "Unknown" : `${link.fileSizeMb} MB` }}
              </td>
              <td class="border-b border-line px-3 py-3">
                <span
                  class="inline-flex rounded-full px-2 py-1 text-xs font-extrabold"
                  :class="link.readable ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'"
                >
                  {{ link.readable ? "Readable" : "Unavailable" }}
                </span>
              </td>
              <td class="max-w-[300px] border-b border-line px-3 py-3">
                <a
                  class="block overflow-wrap-anywhere text-accent hover:underline"
                  :href="link.viewerUrl"
                  target="_blank"
                  rel="noreferrer"
                >
                  {{ link.viewerUrl }}
                </a>
              </td>
              <td class="border-b border-line px-3 py-3">
                <div class="flex flex-wrap gap-2">
                  <button
                    class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-white px-2 font-bold hover:bg-slate-50"
                    type="button"
                    @click="copyText(link.queryHash, `hash-${link.projectNumber}`)"
                  >
                    <Copy :size="15" />
                    {{ copied === `hash-${link.projectNumber}` ? "Copied" : "Hash" }}
                  </button>
                  <button
                    class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-white px-2 font-bold hover:bg-slate-50"
                    type="button"
                    @click="copyText(link.viewerUrl, `url-${link.projectNumber}`)"
                  >
                    <Copy :size="15" />
                    {{ copied === `url-${link.projectNumber}` ? "Copied" : "URL" }}
                  </button>
                  <button
                    class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-white px-2 font-bold hover:bg-slate-50"
                    type="button"
                    @click="openHubSpotDrawer(link)"
                  >
                    <Link2 :size="15" />
                    HubSpot
                  </button>
                  <a
                    class="inline-flex min-h-9 items-center gap-1 rounded-md border border-line bg-white px-2 font-bold text-ink no-underline hover:bg-slate-50"
                    :href="link.viewerUrl"
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink :size="15" />
                    Open
                  </a>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <Transition name="drawer-fade">
      <div
        v-if="selectedHubSpotLink"
        class="fixed inset-0 z-40 bg-slate-950/30"
        @click.self="closeHubSpotDrawer"
      >
        <Transition name="drawer-slide" appear>
        <aside
          class="absolute right-0 top-0 flex h-full w-[min(560px,100vw)] flex-col bg-white shadow-2xl"
          aria-label="HubSpot mapping drawer"
        >
          <header class="border-b border-line p-5">
            <div class="flex items-start justify-between gap-4">
              <div>
                <p class="text-xs font-extrabold uppercase text-muted">HubSpot Mapping</p>
                <h2 class="mt-1 text-2xl font-bold">
                  Project {{ selectedHubSpotLink.projectNumber }}
                </h2>
                <p class="mt-1 text-sm text-muted">{{ selectedHubSpotLink.modelFileName }}</p>
              </div>
              <button
                class="inline-flex h-10 w-10 items-center justify-center rounded-md border border-line bg-white hover:bg-slate-50"
                type="button"
                aria-label="Close HubSpot mapping drawer"
                @click="closeHubSpotDrawer"
              >
                <X :size="18" />
              </button>
            </div>
          </header>

          <div class="flex-1 overflow-y-auto p-5">
            <section class="mb-5 rounded-lg border border-line bg-slate-50 p-4">
              <h3 class="font-bold">Custom Object Properties</h3>
              <p class="mt-1 text-sm text-muted">
                Add these properties to the HubSpot custom object that represents the project.
              </p>
              <div class="mt-4 grid gap-2">
                <div
                  v-for="property in hubspotProperties"
                  :key="property.name"
                  class="grid gap-2 rounded-md border border-line bg-white p-3 md:grid-cols-[1fr_auto]"
                >
                  <div>
                    <p class="text-sm font-bold">{{ property.label }}</p>
                    <code class="mt-1 inline-block rounded bg-slate-100 px-2 py-1 text-xs">
                      {{ property.name }}
                    </code>
                  </div>
                  <div class="text-left md:text-right">
                    <p class="text-xs font-bold text-muted">{{ property.type }}</p>
                    <p
                      class="mt-1 text-xs font-extrabold"
                      :class="property.required ? 'text-red-700' : 'text-muted'"
                    >
                      {{ property.required ? "Required" : "Optional" }}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <section class="mb-5 rounded-lg border border-line bg-white p-4">
              <h3 class="font-bold">Mapped Values</h3>
              <div class="mt-4 grid gap-3">
                <label class="block">
                  <span class="mb-1 block text-xs font-extrabold uppercase text-muted">
                    cad_project_hash
                  </span>
                  <input
                    class="min-h-10 w-full rounded-md border border-line bg-slate-50 px-3 font-mono text-sm"
                    :value="selectedHubSpotLink.queryHash"
                    readonly
                  />
                </label>
                <label class="block">
                  <span class="mb-1 block text-xs font-extrabold uppercase text-muted">
                    cad_viewer_url
                  </span>
                  <input
                    class="min-h-10 w-full rounded-md border border-line bg-slate-50 px-3 text-sm"
                    :value="selectedHubSpotLink.viewerUrl"
                    readonly
                  />
                </label>
                <label class="block">
                  <span class="mb-1 block text-xs font-extrabold uppercase text-muted">
                    cad_hubspot_check_url
                  </span>
                  <input
                    class="min-h-10 w-full rounded-md border border-line bg-slate-50 px-3 text-sm"
                    :value="selectedHubSpotLink.hubspotCheckUrl"
                    readonly
                  />
                </label>
              </div>
            </section>

            <section class="mb-5 rounded-lg border border-line bg-white p-4">
              <h3 class="font-bold">Security Management</h3>
              <p class="mt-1 text-sm text-muted">
                Generate project-specific credentials for HubSpot access to this CAD viewer record.
              </p>

              <div class="mt-4 grid gap-3">
                <label class="block">
                  <span class="mb-1 block text-xs font-extrabold uppercase text-muted">
                    Authorization key
                  </span>
                  <div class="flex gap-2">
                    <input
                      class="min-h-10 min-w-0 flex-1 rounded-md border border-line bg-slate-50 px-3 font-mono text-sm"
                      :value="selectedHubSpotLink.security?.hubspotAccessKey || 'Not generated'"
                      readonly
                    />
                    <button
                      class="inline-flex min-h-10 items-center gap-2 rounded-md border border-line bg-white px-3 font-bold hover:bg-slate-50 disabled:opacity-50"
                      type="button"
                      :disabled="!selectedHubSpotLink.security?.hubspotAccessKey"
                      @click="
                        copyText(
                          selectedHubSpotLink.security.hubspotAccessKey,
                          `access-key-${selectedHubSpotLink.projectNumber}`
                        )
                      "
                    >
                      <Copy :size="15" />
                      {{
                        copied === `access-key-${selectedHubSpotLink.projectNumber}`
                          ? "Copied"
                          : "Copy"
                      }}
                    </button>
                  </div>
                </label>

                <div class="grid gap-2 rounded-md border border-line bg-slate-50 p-3 text-sm">
                  <div class="flex items-center justify-between gap-3">
                    <span class="font-bold text-muted">Secret fingerprint</span>
                    <code class="rounded bg-white px-2 py-1">
                      {{
                        selectedHubSpotLink.security?.hubspotAccessSecretLast4
                          ? `•••• ${selectedHubSpotLink.security.hubspotAccessSecretLast4}`
                          : "Not generated"
                      }}
                    </code>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <span class="font-bold text-muted">Status</span>
                    <span
                      class="rounded-full px-2 py-1 text-xs font-extrabold"
                      :class="
                        selectedHubSpotLink.security?.hubspotAccessEnabled
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-amber-50 text-amber-700'
                      "
                    >
                      {{
                        selectedHubSpotLink.security?.hubspotAccessEnabled
                          ? "Configured"
                          : "Not configured"
                      }}
                    </span>
                  </div>
                  <div class="flex items-center justify-between gap-3">
                    <span class="font-bold text-muted">Last rotated</span>
                    <span>{{ selectedHubSpotLink.security?.rotatedAt || "Never" }}</span>
                  </div>
                </div>

                <div
                  v-if="accessCredentialResult?.queryHash === selectedHubSpotLink.queryHash"
                  class="rounded-md border border-emerald-200 bg-emerald-50 p-3"
                >
                  <p class="text-sm font-bold text-emerald-800">One-time secret</p>
                  <p class="mt-1 text-xs text-emerald-800">
                    Copy this now. After closing this drawer, only the fingerprint will be shown.
                  </p>
                  <div class="mt-3 flex gap-2">
                    <input
                      class="min-h-10 min-w-0 flex-1 rounded-md border border-emerald-200 bg-white px-3 font-mono text-sm"
                      :value="accessCredentialResult.accessSecret"
                      readonly
                    />
                    <button
                      class="inline-flex min-h-10 items-center gap-2 rounded-md border border-emerald-300 bg-white px-3 font-bold text-emerald-800 hover:bg-emerald-50"
                      type="button"
                      @click="
                        copyText(
                          accessCredentialResult.accessSecret,
                          `access-secret-${selectedHubSpotLink.projectNumber}`
                        )
                      "
                    >
                      <Copy :size="15" />
                      {{
                        copied === `access-secret-${selectedHubSpotLink.projectNumber}`
                          ? "Copied"
                          : "Copy"
                      }}
                    </button>
                  </div>
                </div>

                <button
                  class="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-slate-900 px-3 font-bold text-white hover:bg-slate-800 disabled:opacity-60"
                  type="button"
                  :disabled="accessCredentialLoading"
                  @click="rotateAccessCredentials(selectedHubSpotLink)"
                >
                  <ShieldCheck :size="16" />
                  {{
                    accessCredentialLoading
                      ? "Generating"
                      : selectedHubSpotLink.security?.hubspotAccessEnabled
                        ? "Rotate Key And Secret"
                        : "Generate Key And Secret"
                  }}
                </button>

                <div class="rounded-md border border-line bg-white p-3">
                  <div class="rounded-md bg-slate-50 p-3">
                    <p class="text-xs font-extrabold uppercase text-muted">
                      HubSpot custom object record ID
                    </p>
                    <code class="mt-2 block rounded bg-white px-2 py-1 font-mono text-sm">
                      {{ selectedHubSpotLink.projectNumber }}
                    </code>
                    <p class="mt-2 text-xs text-muted">
                      The project number is used as the HubSpot custom object record ID.
                    </p>
                  </div>
                  <button
                    class="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-accent px-3 font-bold text-white hover:bg-sky-700 disabled:opacity-60"
                    type="button"
                    :disabled="publishLoading || !accessCredentialResult?.accessSecret"
                    @click="publishHubSpotProperties(selectedHubSpotLink)"
                  >
                    <Link2 :size="16" />
                    {{ publishLoading ? "Publishing" : "Save / Publish To HubSpot" }}
                  </button>
                  <p class="mt-2 text-xs text-muted">
                    Generate credentials first so the current authorization secret can be included.
                  </p>
                  <div
                    v-if="publishStatus"
                    class="mt-3 rounded-md p-3 text-sm"
                    :class="
                      publishStatus.error
                        ? 'bg-red-50 text-red-700'
                        : publishStatus.published
                          ? 'bg-emerald-50 text-emerald-800'
                          : 'bg-amber-50 text-amber-800'
                    "
                  >
                    {{ publishStatus.message }}
                  </div>
                </div>
              </div>
            </section>

            <section class="mb-5 rounded-lg border border-line bg-white p-4">
              <h3 class="font-bold">Sync Status</h3>
              <div class="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                Direct HubSpot write/sync is not enabled yet. Configure a HubSpot private app token
                and target custom object API name before enabling one-click sync.
              </div>
              <div class="mt-4 grid gap-2 text-sm text-muted">
                <p>1. Add the custom properties above to the HubSpot custom object.</p>
                <p>2. Store the project hash and viewer URL on the matching custom object record.</p>
                <p>3. Configure the HubSpot card to call the check URL using the stored hash.</p>
              </div>
            </section>
          </div>

          <footer class="border-t border-line p-4">
            <div class="flex flex-wrap gap-2">
              <button
                class="inline-flex min-h-10 items-center gap-2 rounded-md border border-line bg-white px-3 font-bold hover:bg-slate-50"
                type="button"
                @click="
                  copyText(
                    createHubSpotPropertyPayload(selectedHubSpotLink),
                    `drawer-values-${selectedHubSpotLink.projectNumber}`
                  )
                "
              >
                <Copy :size="16" />
                {{
                  copied === `drawer-values-${selectedHubSpotLink.projectNumber}`
                    ? "Copied"
                    : "Copy Values"
                }}
              </button>
              <button
                class="inline-flex min-h-10 items-center gap-2 rounded-md border border-line bg-white px-3 font-bold hover:bg-slate-50"
                type="button"
                @click="
                  copyText(
                    createHubSpotJsonPayload(selectedHubSpotLink),
                    `drawer-json-${selectedHubSpotLink.projectNumber}`
                  )
                "
              >
                <Copy :size="16" />
                {{
                  copied === `drawer-json-${selectedHubSpotLink.projectNumber}`
                    ? "Copied"
                    : "Copy JSON"
                }}
              </button>
              <a
                class="inline-flex min-h-10 items-center gap-2 rounded-md bg-slate-900 px-3 font-bold text-white no-underline hover:bg-slate-800"
                :href="selectedHubSpotLink.viewerUrl"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink :size="16" />
                Open Viewer
              </a>
            </div>
          </footer>
        </aside>
        </Transition>
      </div>
      </Transition>
    </section>
  </main>
</template>

<style scoped>
.overflow-wrap-anywhere {
  overflow-wrap: anywhere;
}

.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity 180ms ease;
}

.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}

.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition:
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 180ms ease;
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  opacity: 0;
  transform: translateX(28px);
}
</style>
