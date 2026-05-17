import { db } from "../db.js";

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
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

CREATE TRIGGER IF NOT EXISTS orders_updated_at
AFTER UPDATE ON orders
FOR EACH ROW
BEGIN
  UPDATE orders SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;
`);

const count = db.prepare("SELECT COUNT(*) AS count FROM products").get().count;
if (count === 0) {
  const insertProduct = db.prepare(`
    INSERT INTO products (name, slug, category, description, price, period, specs, provision_config, sort_order)
    VALUES (:name, :slug, :category, :description, :price, :period, :specs, :provision_config, :sort_order)
  `);

  const products = [
    {
      name: "Game Starter",
      slug: "game-starter",
      category: "Game Server",
      description: "適合小型 Minecraft、Palworld 或測試用遊戲伺服器。",
      price: 180,
      period: "monthly",
      specs: { CPU: "100%", Memory: "2 GB", Disk: "20 GB NVMe", DDoS: "Basic" },
      provision_config: {
        limits: { memory: 2048, swap: 0, disk: 20480, io: 500, cpu: 100 },
        feature_limits: { databases: 1, backups: 2, allocations: 1 }
      },
      sort_order: 1
    },
    {
      name: "Game Pro",
      slug: "game-pro",
      category: "Game Server",
      description: "給中型玩家社群使用，保留更高 CPU 與備份額度。",
      price: 420,
      period: "monthly",
      specs: { CPU: "200%", Memory: "6 GB", Disk: "60 GB NVMe", DDoS: "Enhanced" },
      provision_config: {
        limits: { memory: 6144, swap: 0, disk: 61440, io: 500, cpu: 200 },
        feature_limits: { databases: 3, backups: 5, allocations: 2 }
      },
      sort_order: 2
    },
    {
      name: "Cloud Compute S",
      slug: "cloud-compute-s",
      category: "Cloud Compute",
      description: "適合 Discord bot、網站後端、小型 API 與工具服務。",
      price: 260,
      period: "monthly",
      specs: { vCPU: "2 Core", Memory: "4 GB", Disk: "40 GB NVMe", Network: "1 Gbps" },
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

console.log("SQLite database migration completed.");
