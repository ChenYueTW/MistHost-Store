import { db } from "./db.js";

export function runStartupMigrations() {
  db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NULL,
  auth_provider TEXT NOT NULL DEFAULT 'local',
  provider_id TEXT NULL,
  pterodactyl_user_id INTEGER NULL,
  pterodactyl_sync_status TEXT NULL,
  panel_password_last TEXT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  price INTEGER NOT NULL,
  period TEXT NOT NULL DEFAULT 'monthly',
  specs TEXT NOT NULL,
  provision_config TEXT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  subtotal INTEGER NULL,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  coupon_code TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','provisioned','manual','failed')),
  ecpay_trade_no TEXT NULL,
  ecpay_payment_type TEXT NULL,
  paid_at TEXT NULL,
  provision_message TEXT NULL,
  pterodactyl_server_id INTEGER NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  server_type_egg_id INTEGER NULL,
  server_type_nest_id INTEGER NULL,
  server_type_name TEXT NULL,
  provision_status TEXT NULL,
  provision_message TEXT NULL,
  pterodactyl_server_id INTEGER NULL,
  pterodactyl_server_ids TEXT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('percent','fixed')),
  value INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS category_node_settings (
  category TEXT PRIMARY KEY,
  node_id INTEGER NULL,
  node_name TEXT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_password_reset_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS customer_servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  order_id INTEGER NULL,
  order_item_id INTEGER NULL,
  pterodactyl_server_id INTEGER NOT NULL UNIQUE,
  pterodactyl_identifier TEXT NULL,
  name TEXT NOT NULL,
  egg_id INTEGER NULL,
  nest_id INTEGER NULL,
  egg_name TEXT NULL,
  status TEXT NOT NULL DEFAULT 'manual',
  installed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_customer_servers_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_customer_servers_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_customer_servers_order_item FOREIGN KEY (order_item_id) REFERENCES order_items(id)
);

CREATE TRIGGER IF NOT EXISTS orders_updated_at
AFTER UPDATE ON orders
FOR EACH ROW
BEGIN
  UPDATE orders SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS category_node_settings_updated_at
AFTER UPDATE ON category_node_settings
FOR EACH ROW
BEGIN
  UPDATE category_node_settings SET updated_at = CURRENT_TIMESTAMP WHERE category = OLD.category;
END;

CREATE TRIGGER IF NOT EXISTS customer_servers_updated_at
AFTER UPDATE ON customer_servers
FOR EACH ROW
BEGIN
  UPDATE customer_servers SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
`);

  addMissingColumns();
  seedDefaultProducts();
  seedDefaultCoupons();
}

function addMissingColumns() {
  addColumns("customers", [
    ["password_hash", "TEXT NULL"],
    ["auth_provider", "TEXT NOT NULL DEFAULT 'local'"],
    ["provider_id", "TEXT NULL"],
    ["pterodactyl_user_id", "INTEGER NULL"],
    ["pterodactyl_sync_status", "TEXT NULL"],
    ["panel_password_last", "TEXT NULL"]
  ]);

  addColumns("orders", [
    ["subtotal", "INTEGER NULL"],
    ["discount_amount", "INTEGER NOT NULL DEFAULT 0"],
    ["coupon_code", "TEXT NULL"],
    ["ecpay_trade_no", "TEXT NULL"],
    ["ecpay_payment_type", "TEXT NULL"],
    ["paid_at", "TEXT NULL"],
    ["provision_message", "TEXT NULL"],
    ["pterodactyl_server_id", "INTEGER NULL"]
  ]);

  addColumns("order_items", [
    ["server_type_egg_id", "INTEGER NULL"],
    ["server_type_nest_id", "INTEGER NULL"],
    ["server_type_name", "TEXT NULL"],
    ["provision_status", "TEXT NULL"],
    ["provision_message", "TEXT NULL"],
    ["pterodactyl_server_id", "INTEGER NULL"],
    ["pterodactyl_server_ids", "TEXT NULL"]
  ]);

  addColumns("customer_servers", [
    ["pterodactyl_identifier", "TEXT NULL"],
    ["egg_id", "INTEGER NULL"],
    ["nest_id", "INTEGER NULL"],
    ["egg_name", "TEXT NULL"],
    ["status", "TEXT NOT NULL DEFAULT 'manual'"],
    ["installed", "INTEGER NOT NULL DEFAULT 0"]
  ]);
}

function addColumns(table, columns) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  for (const [name, definition] of columns) {
    if (!existing.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function seedDefaultProducts() {
  const count = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;
  if (count > 0) return;

  const minecraftPlans = [
    { name: "Minecraft Oak", slug: "game-starter", core: 1, memory: 2, disk: 10 },
    { name: "Minecraft Stone", slug: "game-pro", core: 2, memory: 4, disk: 20 },
    { name: "Minecraft Iron", slug: "minecraft-builder", core: 4, memory: 8, disk: 30 },
    { name: "Minecraft Gold", slug: "minecraft-redstone", core: 6, memory: 12, disk: 40 },
    { name: "Minecraft Diamond", slug: "minecraft-fortress", core: 8, memory: 16, disk: 50 },
    { name: "Minecraft Emerald", slug: "minecraft-expedition", core: 10, memory: 20, disk: 55 },
    { name: "Minecraft Netherite", slug: "minecraft-realm", core: 12, memory: 24, disk: 60 },
    { name: "Minecraft Dragon", slug: "minecraft-flagship", core: 16, memory: 32, disk: 60 }
  ].map((plan, index) => ({
    name: plan.name,
    slug: plan.slug,
    category: "Minecraft伺服器",
    description: `${plan.core} 核心、${plan.memory} GB 記憶體、${plan.disk} GB NVMe 儲存空間的 Minecraft 伺服器方案。`,
    price: plan.core * 100,
    period: "monthly",
    specs: JSON.stringify({ CPU: `${plan.core} 核心`, Memory: `${plan.memory} GB`, Disk: `${plan.disk} GB NVMe` }),
    provision_config: JSON.stringify({
      limits: { memory: plan.memory * 1024, swap: 0, disk: plan.disk * 1024, io: 500, cpu: plan.core * 100 },
      feature_limits: { databases: Math.max(1, Math.ceil(plan.core / 4)), backups: Math.max(1, Math.ceil(plan.core / 2)), allocations: 1 }
    }),
    sort_order: index + 1
  }));

  const discordPlan = {
    name: "Discord Bot S",
    slug: "cloud-compute-s",
    category: "Discord Bot",
    description: "適合 Discord bot、小型 API 與社群工具服務。",
    price: 260,
    period: "monthly",
    specs: JSON.stringify({ CPU: "2 核心", Memory: "4 GB", Disk: "40 GB NVMe", Network: "1 Gbps" }),
    provision_config: JSON.stringify({
      limits: { memory: 4096, swap: 0, disk: 40960, io: 500, cpu: 200 },
      feature_limits: { databases: 2, backups: 3, allocations: 1 }
    }),
    sort_order: 99
  };

  const insertProduct = db.prepare(`
    INSERT INTO products (name, slug, category, description, price, period, specs, provision_config, active, sort_order)
    VALUES (:name, :slug, :category, :description, :price, :period, :specs, :provision_config, 1, :sort_order)
  `);

  const seed = db.transaction((products) => {
    for (const product of products) insertProduct.run(product);
  });
  seed([...minecraftPlans, discordPlan]);
}

function seedDefaultCoupons() {
  const insertCoupon = db.prepare(`
    INSERT INTO coupons (code, type, value, active)
    VALUES (:code, :type, :value, 1)
    ON CONFLICT(code) DO NOTHING
  `);
  insertCoupon.run({ code: "WELCOME10", type: "percent", value: 10 });
  insertCoupon.run({ code: "HOST50", type: "fixed", value: 50 });
}
