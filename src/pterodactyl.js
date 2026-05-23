import axios from "axios";
import { config } from "./config.js";

function client() {
  return axios.create({
    baseURL: `${config.pterodactyl.panelUrl.replace(/\/$/, "")}/api/application`,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${config.pterodactyl.apiKey}`,
      Accept: "Application/vnd.pterodactyl.v1+json",
      "Content-Type": "application/json"
    }
  });
}

export async function ensurePanelUser({ email, name, password }) {
  if (!config.pterodactyl.enabled) {
    return { status: "disabled", id: null, message: "Pterodactyl sync is disabled in config.json." };
  }

  const api = client();
  const existing = await findPanelUser(api, email);
  if (existing) {
    return { status: "exists", id: existing.id, message: "Pterodactyl user already exists." };
  }

  const username = email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 24);
  const { data } = await api.post("/users", {
    email,
    username: username || `user${Date.now()}`,
    first_name: name || "MistHost",
    last_name: "Customer",
    password
  });

  return { status: "created", id: data.attributes.id, message: "Pterodactyl user created." };
}

export async function getPanelUserByEmail(email) {
  if (!config.pterodactyl.enabled) return null;
  const api = client();
  return findPanelUser(api, email);
}

export async function listPanelNodes() {
  if (!config.pterodactyl.enabled) return [];
  const api = client();
  const { data } = await api.get("/nodes");
  return (data.data || []).map((node) => node.attributes);
}

export async function listMinecraftEggs() {
  if (!config.pterodactyl.enabled) return [];

  const api = client();
  const nestId = await resolveMinecraftNestId(api);
  if (!nestId) return [];

  const { data } = await api.get(`/nests/${nestId}/eggs`, {
    params: { include: "variables", per_page: 100 }
  });
  return (data.data || []).map((egg) => normalizeEgg(egg.attributes));
}

export async function getPanelServer(serverId) {
  if (!config.pterodactyl.enabled || !serverId) return null;
  const api = client();
  const { data } = await api.get(`/servers/${serverId}`);
  return normalizeServer(data.attributes);
}

export async function renamePanelServer({ serverId, name }) {
  if (!config.pterodactyl.enabled) return { status: "disabled", message: "Pterodactyl sync is disabled in config.json." };
  const api = client();
  const server = await getServer(api, serverId);
  await api.patch(`/servers/${serverId}/details`, {
    external_id: server.external_id || null,
    name,
    user: server.user,
    description: server.description || ""
  });
  return { status: "updated" };
}

export async function updatePanelServerEgg({ serverId, nestId, eggId }) {
  if (!config.pterodactyl.enabled) return { status: "disabled", message: "Pterodactyl sync is disabled in config.json." };
  const api = client();
  const egg = await getEgg(api, nestId, eggId);
  const dockerImage = egg.docker_image || firstDockerImage(egg.docker_images);
  if (!dockerImage || !egg.startup) return { status: "manual", message: "Selected egg is missing docker image or startup command." };
  await api.patch(`/servers/${serverId}/startup`, {
    startup: egg.startup,
    environment: defaultEggEnvironment(egg),
    egg: Number(eggId),
    image: dockerImage,
    skip_scripts: false
  });
  return { status: "updated", egg };
}

export function panelServerUrl(identifier) {
  if (!identifier) return config.pterodactyl.panelUrl.replace(/\/$/, "");
  return `${config.pterodactyl.panelUrl.replace(/\/$/, "")}/server/${identifier}`;
}

export async function resetPanelUserPassword({ email, password }) {
  if (!config.pterodactyl.enabled) {
    return { status: "disabled", id: null, message: "Pterodactyl sync is disabled in config.json." };
  }

  const api = client();
  const user = await findPanelUser(api, email);
  if (!user) return { status: "missing", id: null, message: "Pterodactyl user was not found." };

  await api.patch(`/users/${user.id}`, {
    email: user.email,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    password
  });
  return { status: "updated", id: user.id, message: "Pterodactyl password was reset." };
}

export async function verifyPanelCredentials({ email, password }) {
  if (!config.pterodactyl.enabled) return false;

  const panelUrl = config.pterodactyl.panelUrl.replace(/\/$/, "");
  const csrf = await axios.get(`${panelUrl}/sanctum/csrf-cookie`, {
    timeout: 15000,
    validateStatus: (status) => status >= 200 && status < 500
  });
  const cookies = csrf.headers["set-cookie"] || [];
  const cookieHeader = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  const xsrfCookie = cookies.find((cookie) => cookie.startsWith("XSRF-TOKEN="));
  const xsrfToken = xsrfCookie ? decodeURIComponent(xsrfCookie.split(";")[0].split("=")[1]) : "";

  const login = await axios.post(`${panelUrl}/auth/login`, {
    user: email,
    password,
    "g-recaptcha-response": null
  }, {
    timeout: 15000,
    headers: {
      Cookie: cookieHeader,
      "X-XSRF-TOKEN": xsrfToken,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    validateStatus: (status) => status >= 200 && status < 500
  });

  return Boolean(login.data?.data?.complete || login.data?.data?.confirmation_token);
}

export async function provisionServer({ customer, product, order, orderItem, nodeId }) {
  if (!config.pterodactyl.enabled) {
    return { status: "manual", message: "Pterodactyl provisioning is disabled in config.json." };
  }

  const provisionConfig = JSON.parse(product.provision_config || "{}");
  const selectedNestId = Number(orderItem?.server_type_nest_id || provisionConfig.nest || 0);
  const selectedEggId = Number(orderItem?.server_type_egg_id || provisionConfig.egg || 0);
  if (!selectedNestId || !selectedEggId) return { status: "manual", message: "Missing selected Pterodactyl egg." };

  const api = client();
  const egg = await getEgg(api, selectedNestId, selectedEggId);
  const dockerImage = provisionConfig.docker_image || egg.docker_image || firstDockerImage(egg.docker_images);
  const startup = provisionConfig.startup || egg.startup;
  if (!dockerImage || !startup) return { status: "manual", message: "Selected egg is missing docker image or startup command." };

  if (!provisionConfig.allocation && !nodeId) return { status: "manual", message: "No node is configured for this product category." };
  const allocationId = provisionConfig.allocation || await findAvailableAllocation(api, nodeId);
  if (!allocationId) return { status: "manual", message: "Selected node has no available allocation." };

  const panelUser = await ensurePanelUser({
    email: customer.email,
    name: customer.name,
    password: customer.panel_password_last || config.pterodactyl.defaultUserPassword
  });
  if (!panelUser.id) {
    return { status: "manual", message: panelUser.message || "Pterodactyl user sync did not return a user id." };
  }

  const payload = {
    name: `${product.name} #${order.id}-${orderItem?.id || "1"}`,
    user: panelUser.id,
    egg: selectedEggId,
    nest: selectedNestId,
    docker_image: dockerImage,
    startup,
    environment: {
      ...defaultEggEnvironment(egg),
      ...(provisionConfig.environment ?? {})
    },
    limits: provisionConfig.limits ?? limitsFromProduct(product),
    feature_limits: provisionConfig.feature_limits ?? { databases: 1, backups: 1, allocations: 1 },
    allocation: {
      default: allocationId
    },
    start_on_completion: true
  };
  if (provisionConfig.deploy) payload.deploy = provisionConfig.deploy;

  const { data } = await api.post("/servers", payload);
  const server = normalizeServer(data.attributes);
  return {
    status: server.installed ? "provisioned" : "manual",
    pterodactylServerId: server.id,
    identifier: server.identifier,
    installed: server.installed,
    name: server.name
  };
}

async function findPanelUser(api, email) {
  const response = await api.get("/users", {
    params: { "filter[email]": email }
  });
  return response.data.data?.[0]?.attributes ?? null;
}

async function resolveMinecraftNestId(api) {
  const configuredNestId = Number(config.pterodactyl.minecraftNestId || 0);
  if (configuredNestId) return configuredNestId;

  const { data } = await api.get("/nests", { params: { per_page: 100 } });
  const nest = (data.data || [])
    .map((entry) => entry.attributes)
    .find((entry) => String(entry.name || "").toLowerCase().includes("minecraft"));
  return nest?.id || null;
}

async function getEgg(api, nestId, eggId) {
  const { data } = await api.get(`/nests/${nestId}/eggs/${eggId}`, {
    params: { include: "variables" }
  });
  return normalizeEgg(data.attributes);
}

async function getServer(api, serverId) {
  const { data } = await api.get(`/servers/${serverId}`);
  return normalizeServer(data.attributes);
}

function normalizeServer(server) {
  const installed = server.container?.installed ?? server.installed;
  return {
    id: server.id,
    uuid: server.uuid,
    identifier: server.identifier,
    external_id: server.external_id,
    name: server.name,
    description: server.description,
    user: server.user,
    nest: server.nest,
    egg: server.egg,
    suspended: Boolean(server.suspended),
    installed: installed === true || installed === 1 || installed === "1" || installed === "installed"
  };
}

function normalizeEgg(egg) {
  const relationships = egg.relationships || {};
  const variables = relationships.variables?.data || egg.variables?.data || egg.variables || [];
  return {
    id: egg.id,
    uuid: egg.uuid,
    nest: egg.nest,
    name: egg.name,
    description: egg.description,
    docker_image: egg.docker_image,
    docker_images: egg.docker_images,
    startup: egg.startup,
    variables: variables.map((variable) => variable.attributes || variable)
  };
}

function firstDockerImage(images) {
  if (!images || typeof images !== "object") return null;
  return Object.values(images)[0] || null;
}

function defaultEggEnvironment(egg) {
  return (egg.variables || []).reduce((environment, variable) => {
    const key = variable.env_variable;
    if (key) environment[key] = variable.default_value ?? "";
    return environment;
  }, {});
}

function limitsFromProduct(product) {
  const specs = parseSpecs(product.specs);
  return {
    memory: Math.max(512, specs.memoryGb * 1024),
    swap: 0,
    disk: Math.max(1024, specs.diskGb * 1024),
    io: 500,
    cpu: Math.max(100, specs.cpuCores * 100)
  };
}

function parseSpecs(rawSpecs) {
  try {
    const specs = typeof rawSpecs === "string" ? JSON.parse(rawSpecs || "{}") : rawSpecs || {};
    return {
      cpuCores: extractNumber(specs.CPU, 1),
      memoryGb: extractNumber(specs.Memory, 1),
      diskGb: extractNumber(specs.Disk, 10)
    };
  } catch {
    return { cpuCores: 1, memoryGb: 1, diskGb: 10 };
  }
}

function extractNumber(value, fallback) {
  const match = String(value || "").match(/\d+/);
  return match ? Number.parseInt(match[0], 10) || fallback : fallback;
}

async function findAvailableAllocation(api, nodeId) {
  const selectedNodeId = Number(nodeId || 0);
  if (!selectedNodeId) return null;

  let page = 1;
  let totalPages = 1;
  do {
    const { data } = await api.get(`/nodes/${selectedNodeId}/allocations`, {
      params: { page, per_page: 100 }
    });
    const allocation = (data.data || []).map((entry) => entry.attributes).find((entry) => !entry.assigned);
    if (allocation) return allocation.id;
    totalPages = Number(data.meta?.pagination?.total_pages || 1);
    page += 1;
  } while (page <= totalPages);

  return null;
}
