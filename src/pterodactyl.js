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

  const api = client();
  const user = await ensureUser(api, customer);
  const payload = {
    name: `${product.name} #${order.id}`,
    user: user.id,
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

async function ensureUser(api, customer) {
  const response = await api.get("/users", {
    params: { "filter[email]": customer.email }
  });
  const existing = response.data.data?.[0]?.attributes;
  if (existing) return existing;

  const username = customer.email.split("@")[0].replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 24);
  const { data } = await api.post("/users", {
    email: customer.email,
    username: username || `user${customer.id}`,
    first_name: customer.name || "MistHost",
    last_name: "Customer",
    password: config.pterodactyl.defaultUserPassword
  });
  return data.attributes;
}
