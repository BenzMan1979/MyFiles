# 隨身密閱 Vault Viewer

免安裝的加密文件檢視器。把一批文件加密成**一個 `.vault.html` 檔**，收件人雙擊就能用瀏覽器開啟，
輸入**密碼＋金鑰**後，左邊是檔案列表、右邊是內容。可以限制期限、次數，加上浮水印，並隨時遠端收回。

- **打包器（給發送者）**：https://benzman1979.github.io/MyFiles/vault-viewer/ （待 Pages 部署啟用，見下方「部署」）
- **手機檢視頁（給收件人）**：https://benzman1979.github.io/MyFiles/vault-viewer/open.html

企劃與決策紀錄：[docs/PROPOSAL.md](docs/PROPOSAL.md)

## 目前進度：P0 完成

**打包器**（一個網頁，也可以存成單一 HTML 離線使用；全程不需要打指令）
- 伺服器設定精靈：註冊 Cloudflare → 一鍵部署 → 貼網址 → 測試連線並登入；可以有多台伺服器，可編輯、切換、移除，也能更換管理員密碼
- 建立封存檔精靈：選檔案／資料夾 → 名稱與模式 → 期限、次數、錯誤鎖定 → 浮水印與防護 → 收件人 → 產生
- 每位收件人各自一份封存檔、`.key` 金鑰檔、可列印的金鑰卡（含 QR Code），另外附一份只給發送者看的交付清單
- 可以一次存到資料夾（Chrome／Edge）或下載成 ZIP
- 管理頁：查看開啟次數、最後開啟時間、開啟紀錄（時間、地區、IP、瀏覽器），可以收回、恢復、延長期限、調整次數、解除鎖定、刪除

**檢視器**（就是封存檔本身）
- 線上模式：伺服器檢查期限、次數、收回狀態，以及密碼錯誤鎖定；離線模式：記在本機，只能防君子
- 預覽：PDF、圖片、影片、音訊、文字／程式碼、Markdown、網頁（安全模式）
- 防護：浮水印（收件人＋時間）、禁止複製／列印／下載、閒置或離開視窗自動上鎖
- 手機用線上檢視頁開啟同一個檔案，解密只在手機上進行

**伺服器**（Cloudflare Workers＋Durable Objects，免費方案即可）

## 安全設計

- 內容金鑰 = HKDF(Argon2id(密碼) ‖ 金鑰 ‖ 伺服器分片)，三樣缺一就解不開；伺服器自己也解不開
- 伺服器只存「驗證用金鑰」（由密碼和金鑰推導，無法反推回去），開啟時用一次性挑戰值加 HMAC 驗證
- 每個檔案各自用 AES-256-GCM 加密；檔名、收件人、使用條件都在加密的索引裡，竄改會被偵測

已知限制：擋不住截圖和翻拍（所以有浮水印）；線上模式放行之後，懂技術的人可以把當下的內容存下來；
離線模式的次數與期限可以被繞過。

## 開發

```bash
npm install
npm test            # 單元測試（加密核心、封存格式、伺服器邏輯）
npm run test:e2e    # 建置後用 Chromium 實測檢視器與打包器
npm run build       # dist/index.html（打包器）、dist/open.html（手機檢視頁）
npm run dev         # 打包器開發伺服器（需先 npm run build:viewer）
```

伺服器（`server/`，可獨立部署，也是一鍵部署按鈕的來源）：

```bash
cd server
npm install
npx wrangler dev    # 本機模擬；在 server/.dev.vars 寫 ADMIN_PASSWORD=...
```

## 結構

```
src/core/     加密、封存格式、金鑰文字、MIME（打包器與檢視器共用，有測試）
src/viewer/   檢視器：解鎖、樹狀列表、預覽、防護 → 建置成單一 HTML 模板
src/app/      打包器：伺服器精靈、建立精靈、管理頁、說明
src/shared/   共用樣式、DOM 工具、網址設定
server/       Cloudflare Worker＋Durable Object（hub.ts 為不依賴 Cloudflare 的核心邏輯）
tests/        單元測試；tests/e2e/ 為瀏覽器端對端測試
```

## 部署

- GitHub Pages：**尚未啟用**。要啟用時，把 `docs/deploy-pages.example.yml` 複製成 `.github/workflows/deploy-pages.yml`，
  並到 repo 設定 → Pages，把來源選成「GitHub Actions」。在那之前，可以先用 `npm run build` 產生的 `dist/index.html`（打包器）直接雙擊使用。
- 伺服器：`.github/workflows/deploy-vault-server.yml`，需要 repo Secrets `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
  （選填 `VAULT_ADMIN_PASSWORD`）；沒有設定就自動略過
