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

export async function provisionServer({ customer, product, order }) {
  if (!config.pterodactyl.enabled) {
    return { status: "manual", message: "Pterodactyl provisioning is disabled in config.json." };
  }

  const provisionConfig = JSON.parse(product.provision_config || "{}");
  const required = ["egg", "nest", "location", "allocation", "docker_image", "startup"];
  const missing = required.filter((key) => !provisionConfig[key]);
  if (missing.length > 0) {
    return { status: "manual", message: `Missing product provision_config: ${missing.join(", ")}` };
  }

  const panelUser = await ensurePanelUser({
    email: customer.email,
    name: customer.name,
    password: config.pterodactyl.defaultUserPassword
  });
  if (!panelUser.id) {
    return { status: "manual", message: panelUser.message || "Pterodactyl user sync did not return a user id." };
  }

  const api = client();
  const payload = {
    name: `${product.name} #${order.id}`,
    user: panelUser.id,
    egg: provisionConfig.egg,
    nest: provisionConfig.nest,
    docker_image: provisionConfig.docker_image,
    startup: provisionConfig.startup,
    environment: provisionConfig.environment ?? {},
    limits: provisionConfig.limits ?? { memory: 1024, swap: 0, disk: 10240, io: 500, cpu: 100 },
    feature_limits: provisionConfig.feature_limits ?? { databases: 1, backups: 1, allocations: 1 },
    allocation: {
      default: provisionConfig.allocation
    },
    deploy: provisionConfig.deploy,
    start_on_completion: true
  };

  const { data } = await api.post("/servers", payload);
  return { status: "provisioned", pterodactylServerId: data.attributes.id };
}

async function findPanelUser(api, email) {
  const response = await api.get("/users", {
    params: { "filter[email]": email }
  });
  return response.data.data?.[0]?.attributes ?? null;
}
