import { db } from "../db.js";

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
  provision_status TEXT NULL,
  provision_message TEXT NULL,
  pterodactyl_server_id INTEGER NULL,
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
`);

const customerColumns = db.prepare("PRAGMA table_info(customers)").all().map((column) => column.name);
const addCustomerColumn = (name, definition) => {
  if (!customerColumns.includes(name)) db.exec(`ALTER TABLE customers ADD COLUMN ${name} ${definition}`);
};
addCustomerColumn("password_hash", "TEXT NULL");
addCustomerColumn("auth_provider", "TEXT NOT NULL DEFAULT 'local'");
addCustomerColumn("provider_id", "TEXT NULL");
addCustomerColumn("pterodactyl_user_id", "INTEGER NULL");
addCustomerColumn("pterodactyl_sync_status", "TEXT NULL");
addCustomerColumn("panel_password_last", "TEXT NULL");

const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((column) => column.name);
const addOrderColumn = (name, definition) => {
  if (!orderColumns.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
};
addOrderColumn("subtotal", "INTEGER NULL");
addOrderColumn("discount_amount", "INTEGER NOT NULL DEFAULT 0");
addOrderColumn("coupon_code", "TEXT NULL");

const count = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;
if (count === 0) {
  const insertProduct = db.prepare(`
    INSERT INTO products (name, slug, category, description, price, period, specs, provision_config, sort_order)
    VALUES (:name, :slug, :category, :description, :price, :period, :specs, :provision_config, :sort_order)
  `);

  const products = [
    {
      name: "Minecraft Starter",
      slug: "game-starter",
      category: "Minecraft伺服器",
      description: "適合小型 Minecraft 生存伺服器與好友同樂。",
      price: 180,
      period: "monthly",
      specs: { CPU: "1 核心", Memory: "2 GB", Disk: "20 GB NVMe", DDoS: "Basic" },
      provision_config: {
        limits: { memory: 2048, swap: 0, disk: 20480, io: 500, cpu: 100 },
        feature_limits: { databases: 1, backups: 2, allocations: 1 }
      },
      sort_order: 1
    },
    {
      name: "Minecraft Pro",
      slug: "game-pro",
      category: "Minecraft伺服器",
      description: "給中型玩家社群使用，保留更高 CPU 與備份額度。",
      price: 420,
      period: "monthly",
      specs: { CPU: "2 核心", Memory: "6 GB", Disk: "60 GB NVMe", DDoS: "Enhanced" },
      provision_config: {
        limits: { memory: 6144, swap: 0, disk: 61440, io: 500, cpu: 200 },
        feature_limits: { databases: 3, backups: 5, allocations: 2 }
      },
      sort_order: 2
    },
    {
      name: "Discord Bot S",
      slug: "cloud-compute-s",
      category: "Discord Bot",
      description: "適合 Discord bot、小型 API 與社群工具服務。",
      price: 260,
      period: "monthly",
      specs: { CPU: "2 核心", Memory: "4 GB", Disk: "40 GB NVMe", Network: "1 Gbps" },
      provision_config: {
        limits: { memory: 4096, swap: 0, disk: 40960, io: 500, cpu: 200 },
        feature_limits: { databases: 2, backups: 3, allocations: 1 }
      },
      sort_order: 3
    }
  ];

  const seed = db.transaction((rows) => {
    for (const product of rows) {
      insertProduct.run({
        ...product,
        specs: JSON.stringify(product.specs),
        provision_config: JSON.stringify(product.provision_config)
      });
    }
  });

  seed(products);
}

const productUpdates = [
  {
    slug: "game-starter",
    name: "Minecraft 入門",
    category: "Minecraft伺服器",
    specs: JSON.stringify({ CPU: "1 核心", Memory: "2 GB", Disk: "10 GB NVMe", DDoS: "Basic" }),
    description: "適合小型 Minecraft 生存伺服器與好友同樂。"
  },
  {
    slug: "game-pro",
    name: "Minecraft 生存",
    category: "Minecraft伺服器",
    specs: JSON.stringify({ CPU: "2 核心", Memory: "4 GB", Disk: "20 GB NVMe", DDoS: "Enhanced" }),
    description: "給中型玩家社群使用，保留更高 CPU 與備份額度。"
  },
  {
    slug: "cloud-compute-s",
    name: "Discord Bot S",
    category: "Discord Bot",
    specs: JSON.stringify({ CPU: "2 核心", Memory: "4 GB", Disk: "40 GB NVMe", Network: "1 Gbps" }),
    description: "適合 Discord bot、小型 API 與社群工具服務。"
  }
];
const updateProduct = db.prepare("UPDATE products SET name = :name, category = :category, specs = :specs, description = :description WHERE slug = :slug");
for (const product of productUpdates) updateProduct.run(product);

const minecraftPlans = [
  { name: "Minecraft 入門", slug: "game-starter", core: 1, memory: 2, disk: 10 },
  { name: "Minecraft 生存", slug: "game-pro", core: 2, memory: 4, disk: 20 },
  { name: "Minecraft 工匠", slug: "minecraft-builder", core: 4, memory: 8, disk: 30 },
  { name: "Minecraft 紅石", slug: "minecraft-redstone", core: 6, memory: 12, disk: 40 },
  { name: "Minecraft 要塞", slug: "minecraft-fortress", core: 8, memory: 16, disk: 50 },
  { name: "Minecraft 遠征", slug: "minecraft-expedition", core: 10, memory: 20, disk: 55 },
  { name: "Minecraft 領域", slug: "minecraft-realm", core: 12, memory: 24, disk: 60 },
  { name: "Minecraft 旗艦", slug: "minecraft-flagship", core: 16, memory: 32, disk: 60 }
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

const upsertMinecraftPlan = db.prepare(`
  INSERT INTO products (name, slug, category, description, price, period, specs, provision_config, active, sort_order)
  VALUES (:name, :slug, :category, :description, :price, :period, :specs, :provision_config, 1, :sort_order)
  ON CONFLICT(slug) DO UPDATE SET
    name = excluded.name,
    category = excluded.category,
    description = excluded.description,
    price = excluded.price,
    period = excluded.period,
    specs = excluded.specs,
    provision_config = excluded.provision_config,
    active = 1,
    sort_order = excluded.sort_order
`);
const minecraftPlanSlugs = minecraftPlans.map((plan) => plan.slug);
for (const plan of minecraftPlans) upsertMinecraftPlan.run(plan);
db.prepare(`
  UPDATE products
  SET active = 0
  WHERE category = 'Minecraft伺服器'
    AND slug NOT IN (${minecraftPlanSlugs.map(() => "?").join(",")})
`).run(...minecraftPlanSlugs);
db.prepare(`
  DELETE FROM products
  WHERE category = 'Minecraft伺服器'
    AND slug GLOB 'minecraft-[0-9]*c-[0-9]*g-[0-9]*g'
    AND slug NOT IN (${minecraftPlanSlugs.map(() => "?").join(",")})
    AND NOT EXISTS (SELECT 1 FROM orders WHERE orders.product_id = products.id)
    AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_items.product_id = products.id)
`).run(...minecraftPlanSlugs);

const insertCoupon = db.prepare(`
  INSERT INTO coupons (code, type, value, active)
  VALUES (:code, :type, :value, 1)
  ON CONFLICT(code) DO UPDATE SET type = excluded.type, value = excluded.value, active = 1
`);
insertCoupon.run({ code: "WELCOME10", type: "percent", value: 10 });
insertCoupon.run({ code: "HOST50", type: "fixed", value: 50 });

console.log("SQLite database migration completed.");
