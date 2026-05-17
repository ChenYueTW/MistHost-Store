# MistHost Store

JavaScript/Node.js 商店系統，使用 SQLite 檔案儲存資料、ECPay 綠界全方位金流結帳，付款完成後可串接 Pterodactyl Panel API 建立主機服務。

## 設定

所有主要設定都在根目錄 `config.json`：

- `port`: 預設 `3000`
- `database.file`: SQLite 資料庫檔案路徑，預設 `data/store.db`
- `pterodactyl`: Panel URL、Application API Key 與是否啟用自動開通
- `ecpay`: MerchantID、HashKey、HashIV、正式/測試環境

## 啟動

```bash
npm install
npm run db:migrate
npm run dev
```

網站會啟動在 `http://localhost:3000`，資料會寫入 `data/store.db`。

## Pterodactyl 商品欄位

`products.provision_config` 需放入 Pterodactyl 建立伺服器需要的設定。若資料不足或 `pterodactyl.enabled` 為 `false`，系統會保留訂單狀態並標記為待人工開通。
