# 隨身密閱 Vault Viewer

免安裝的加密文件檢視器。把一批文件加密成**一個 `.vault.html` 檔**，收件人雙擊就能用瀏覽器開啟，
輸入**密碼＋金鑰**後，左邊是檔案列表、右邊是內容。可以限制期限、次數，加上浮水印，並隨時遠端收回。
也可以改用**雲端連結**：加密後的內容放在你自己的 Google Drive、Nextcloud（WebDAV）或 Cloudflare R2，收件人打開網址就能看。

這個 repo 只是**部署器**：程式碼和部署流程放這裡，實際的網站和伺服器跑在**每個人自己的 Cloudflare**，
資料都在你自己的帳號裡。企劃與決策紀錄：[docs/PROPOSAL.md](docs/PROPOSAL.md)

## 自己部署一份（拿到這個 repo 的人）

部署出來的是**一個網址**，同時是：打包器網頁（`/`）、手機檢視頁（`/open.html`）、驗證伺服器（`/api/*`）。
免費方案就夠用，不需要信用卡。

### 方法一：Cloudflare 一鍵部署（最簡單，不用打指令）

1. 註冊 Cloudflare 免費帳號（https://dash.cloudflare.com/sign-up ）。
2. 按這個按鈕：
   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/BenzMan1979/MyFiles/tree/main/vault-viewer)
3. 照畫面登入、連結 GitHub，看到 **`ADMIN_PASSWORD`** 時填入你的管理員密碼（至少 8 個字元），按部署。
4. 部署完成後打開畫面上的 `https://….workers.dev` 網址，左邊選「伺服器設定」，輸入管理員密碼登入就完成了。

> 這個方法的 repo 必須是**公開**的，按鈕才讀得到；不想公開請用方法二或三。網址若有變動，只要改上面那個按鈕連結（`url=` 後面）。
> 程式裡的連結不用改：打包器裡的「部署到 Cloudflare」按鈕是建置時依正在建置的 repo 自動產生的。

### 方法二：Cloudflare 直接連 Git（私有 repo 可用，不用打指令）

一鍵部署按鈕需要公開的 repo；私有 repo 改由 Cloudflare 直接讀取：

1. 在 Cloudflare 主控台：Workers 和 Pages →「建立」→「匯入 Git 儲存庫」。
2. 連結 GitHub，授權 Cloudflare 讀取這個 repo（私有也可以，要有存取權）。
3. 專案名稱填 `vault-viewer`，**根目錄**填 `vault-viewer`，**建置指令**填 `npm run build`，**部署指令**填 `npx wrangler deploy`。
4. 在「變數」加上 `ADMIN_PASSWORD`（管理員密碼，類型選機密）；想改設定就再加 `VAULT_SETTINGS`（JSON，見下面「參數」）。
5. 部署，完成後打開 `https://….workers.dev` 登入即可。

### 方法三：用 GitHub Actions 部署（私有 repo、fork 都可以，不公開任何東西）

1. Fork 或複製這個 repo（可以設成私有）。
2. 在 Cloudflare 建立 API Token（權限：帳戶 → Workers 指令碼 → 編輯；帳戶 → 帳戶設定 → 讀取），並記下 Account ID。
3. 到 repo 的 **Settings → Secrets and variables → Actions**：
   - **Secrets**：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；建議再加 `VAULT_ADMIN_PASSWORD`（部署時直接設好管理員密碼）。
   - **Variables**（選填）：`VAULT_SETTINGS`，內容是下面「參數」的 JSON。
4. 到 Actions 頁籤執行「Deploy to Cloudflare」，之後推送到 `main` 也會自動部署。

### 開發時的預覽：GitHub Pages（選用）

`.github/workflows/deploy-pages.yml` 會在推送到 `main` 後約一分鐘，把打包器（`/`）和手機檢視頁（`/open.html`）發布到 GitHub Pages，方便開發時馬上看效果。
需要在 repo 的 **Settings → Pages → Source** 選「GitHub Actions」。Pages 是靜態網站，**沒有伺服器**：離線封存檔完全可用；要用線上模式，在打包器的「伺服器設定」貼上你部署在 Cloudflare 的網址。

### 讓 Cloudflare 跟著 GitHub 自動更新

用方法二（連結 Git）或方法三（Actions）部署後，之後只要更新 GitHub，Cloudflare 就會自動重新部署，不用手動更新；封存檔的資料存在 Cloudflare 上，重新部署不會被清掉。
**已經用一鍵部署、Worker 名稱不是 `vault-viewer`，想改成跟著這個 repo 更新**：一鍵部署會把程式複製成你帳號下的另一個 repo，之後就只跟著那份複製更新，這個 repo 的更新不會過去。在 Cloudflare 的 Worker →「設定」→「建置」中斷連線、重新連接這個 repo，並設定：根目錄 `vault-viewer`；部署指令 `npm run deploy:ci`；建置變數 `VAULT_SETTINGS` ＝ `{"worker":{"name":"你原本的 Worker 名稱"}}`。名稱必須和原本的一樣，資料才會留在原處（改名字等於建立新的空 Worker）。Cloudflare 會提示「設定檔的名稱不一致」，這只是提醒，可以忽略；它之後若自動開 PR 要你改名稱，不用合併。

想把「開發」和「正式」分開：在 Cloudflare 的專案設定把**生產分支**改成 `release`，開發時推 `main`（看 Pages 預覽），確定沒問題再把 `main` 合併到 `release`，Cloudflare 才會更新。

### 用 Cloudflare Access 保護打包器（選用）

打包器網頁本身沒有機密，管理 API 也有管理員密碼與錯誤鎖定，不加 Access 也安全。想再多一層「只有自己人進得去打包器」，可以用 Cloudflare Access，
但**要小心：不能整個網站一起鎖**。收件人開啟線上封存檔時，是在他們的瀏覽器裡直接呼叫這個網址的 `/api/open`；整站都被 Access 擋住，他們就**打不開**（離線封存檔不受影響，因為不連線）。

需要用自己的網域（Access 才能分路徑設定）。在 Cloudflare 的 Zero Trust →「Access 控制」→「應用程式」建立兩個「自我裝載」應用程式，類型選「公開 DNS」（不要選「Workers」，那個會整個 Worker 一起鎖）：

| 應用程式 | 公開主機名稱（路徑） | 原則 |
|---|---|---|
| A：打包器 | 你的網域，**路徑留空**（整個網站） | **允許**，條件「電子郵件」填你自己（和同事）的 Email |
| B：收件人入口 | 同一個網域，三筆路徑：`open.html`、`api/open`、`api/open/*` | **略過（Bypass）**，條件「所有人」 |

路徑更精確的應用程式優先，所以 B 的那三處不用登入，其餘全部要登入。放行的那幾處本來就有保護：要同時有密碼和金鑰才解得開，錯太多次會鎖定，也能隨時收回。
設好之後：從檔案開啟的「離線打包器」連不到被保護的管理 API（它沒有 Access 的登入），只能做離線模式的封存檔；要做線上封存檔或管理，請用網站上的打包器。GitHub Pages 預覽頁同理。

`/api/info` 只是連線檢查，保護或不保護都可以。更簡單的替代：不加 Access，改用參數 `ADMIN_ORIGINS` 限制只有你的網址能從瀏覽器呼叫管理 API。
Workers 設定裡「用 Cloudflare Access 保護 workers.dev」的開關是整個 Worker 一起鎖，無法排除路徑，所以**有線上封存檔要給別人開時不要用那個開關**。

### 方法四：自己的電腦

```bash
cd vault-viewer
npm install
npm run build
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npm run deploy:ci   # 讀 VAULT_SETTINGS 或 settings.json
```

## 參數（設定值都不在程式碼裡）

所有會因人而異的東西都是參數，來源依序是：環境變數 `VAULT_SETTINGS`（GitHub 的 Variable 或 Cloudflare 的建置變數）→ 本機的 `settings.json` → 內建預設值。
每個欄位都可以省略。範例：[settings.example.json](settings.example.json)（值就是預設值，可以直接複製）。

```jsonc
{
  "app": {                       // 寫進打包器與每份封存檔的檢視器（建置時）
    "appName": "隨身密閱",        // 產品名稱
    "workerName": "vault-viewer", // 只用在說明文字裡的範例網址
    "projectDir": "vault-viewer", // 專案在 repo 裡的資料夾（說明文字與部署連結用）
    "autoAddServer": true,        // 從伺服器本身的網址開啟打包器時，自動把這台伺服器加進清單（只差輸入管理員密碼）
    "links": {
      "deployRepo": "…",          // 一鍵部署要複製的 repo 資料夾；不寫＝自動指向正在建置的 repo；""＝隱藏按鈕
      "deployButtonBase": "https://deploy.workers.cloudflare.com/?url=",
      "cloudflareSignup": "https://dash.cloudflare.com/sign-up",
      "cloudflareDashboard": "https://dash.cloudflare.com/"
    },
    "limits": { "maxRecipients": 500, "maxTotalMB": 300, "phoneMB": 100, "cloudMaxTotalMB": 2048, "minPasswordLength": 6 }, // phoneMB：超過就提醒手機可能打不開；cloudMaxTotalMB：雲端連結一份的上限
    "defaults": {                 // 打包精靈一開始的預設值
      "expiryDays": 30,           // null＝不限期
      "maxFailures": 5, "sessionMinutes": 30, "idleLockMinutes": 10, "blurLockSeconds": 0,
      "allowCopy": false, "allowPrint": false, "allowDownload": false,
      "pdfAsImages": false, "pdfImageWidth": 1600, "pdfImageQuality": 85,  // PDF 是否預設轉成圖片、圖片寬度（px）與 JPEG 畫質
      "watermark": { "enabled": true, "text": "{收件人}  {時間}", "opacity": 0.16, "size": 18, "density": 3 }
    }
  },
  "server": {                     // 部署時變成 Worker 變數（也能之後在 Cloudflare 主控台改）
    "ADMIN_SESSION_HOURS": 12,    // 管理員登入有效幾小時
    "ADMIN_MAX_FAILURES": 5,      // 密碼錯幾次鎖定
    "ADMIN_LOCK_MINUTES": 15,     // 鎖定多久
    "ADMIN_ORIGINS": "",          // 只允許哪些網站用瀏覽器呼叫管理 API（逗號分隔；空＝不限）
    "LOG_RETENTION_DAYS": 365     // 開啟紀錄保留幾天（0＝永遠保留）；統計圖表也以這些紀錄為準
  },
  "worker": { "name": "vault-viewer", "domain": "vault.example.com" }  // Worker 名稱；自訂網域（選填）
}
```

- `ADMIN_PASSWORD` 是**機密**，不放在參數裡：一鍵部署時填，或用 `VAULT_ADMIN_PASSWORD` Secret。它同時是**備用鑰匙**：就算在打包器裡把管理員密碼改掉了，部署時填的這組仍然能登入（要讓它失效，請到 Cloudflare 的 Worker 設定改掉或刪除這個機密）。忘記或被人改掉打包器裡的新密碼時，用它登入再重設即可。
- 填錯會直接說明：JSON 壞了、參數名稱打錯、型別不對都會被攔下或回到預設值，不會做出壞掉的網站。
- 參數寫進網頁後就是公開內容（只有名稱、連結、預設值），不要放機密。

## 功能

**打包器**（一個網頁，也可以存成單一 HTML 離線使用；全程不需要打指令）
- 伺服器設定精靈；若網頁本身就是伺服器（上面的部署方式），會自動偵測，只要登入
- 建立封存檔精靈：選檔案／資料夾 → 名稱與模式 → 期限、次數、錯誤鎖定 → 浮水印與防護 → 收件人 → 產生
- 收件人可以一個一個填，也可以用 **CSV 一次匯入**（名稱、密碼、備註；提供範本，Excel 的 Big5 與 UTF-8 檔都能讀），密碼旁有複製按鈕
- 每位收件人各自一份封存檔、`.key` 金鑰檔、可列印的金鑰卡（含 QR Code），另外附一份只給發送者看的交付清單
- 可以一次存到資料夾（Chrome／Edge）或下載成 ZIP
- 統計圖表（管理頁最上方）：近 7／30／90 天的開啟與異常次數（和前一段期間比較）、每日開啟柱狀圖（可切成表格）、開啟地區與收件人排行、異常事件（密碼錯誤、被鎖定、收回或過期後仍有人嘗試）。以伺服器的開啟紀錄計算，紀錄預設保留 365 天（`LOG_RETENTION_DAYS`）
- 管理頁：查看開啟次數、最後開啟時間、開啟紀錄（時間、地區、IP、瀏覽器、浮水印編號），可以收回、恢復、延長期限、調整次數、解除鎖定、刪除
- **雲端連結**（「☁️ 雲端空間」頁，管理員登入後才能設定）：伺服器連到你自己的雲端空間，建立封存檔時在「交付方式」選「雲端連結」，每位收件人拿到一個網址（`https://你的伺服器/v/<編號>`），不用寄檔案
  - 支援 **Google Drive**（用你自己在 Google Cloud 建立的 OAuth 用戶端，只要 `drive.file` 權限：只看得到它自己建立的檔案）、**WebDAV**（Nextcloud、Koofr、Synology、ownCloud…）、**S3 相容**（Cloudflare R2、Backblaze B2、Wasabi、MinIO…）；可以同時連好幾個，選一個當預設
  - 雲端上只有加密後的內容，切成每段 32MB；收件人通過伺服器檢查（密碼＋金鑰、期限、次數、沒有收回）後，伺服器才從雲端轉給他，**只讀取他點開的檔案**，所以可以放比較大的內容（預設一份最大 2GB），手機也能開
  - 收回後，正在看的人也讀不到還沒看過的檔案；刪除封存檔時，雲端上的檔案一起刪除
  - 雲端的帳號、密碼、授權只存在你的伺服器（Durable Object），不會傳回打包器網頁
  - 自己架的 Nextcloud 必須能從網際網路用 https 連到；放在家裡建議用 Cloudflare Tunnel
  - Google Drive 的 OAuth 同意畫面請發布成「正式版」，留在「測試」狀態的授權每 7 天就會失效
  - 要再加一種雲端（OneDrive、Dropbox…）：在 `server/src/storage/` 寫一個 adapter（實作 `test／prepare／put／get／remove` 五個方法），再登記到 `storage/index.ts`

**檢視器**（就是封存檔本身）
- 線上模式：伺服器檢查期限、次數、收回狀態，以及密碼錯誤鎖定；離線模式：記在本機，只能防君子
- 預覽：PDF、圖片、影片、音訊、文字／程式碼、Markdown、網頁（安全模式）、**Word（.docx）、Excel（.xlsx）**
  - Word 用 docx-preview 呈現，版面可能和 Word 略有差異；Excel 顯示儲存時的計算結果（不含公式、圖表、圖片），分頁以工作表標籤切換
  - 舊版 .doc／.xls 和 PowerPoint 無法預覽，請先另存成新版或 PDF
  - PDF 在**允許複製**時多一層透明文字，可以選取、搜尋；不允許時完全沒有文字層（沒有東西可複製）
  - 打包時可以選**把 PDF 轉成逐頁圖片**（適合簡報）：封存檔裡完全沒有文字，收件人看到的是一份可捲動的文件；檔案會大好幾倍，也不能下載原 PDF
- 防護：浮水印（可調濃淡、字型大小、密集程度）、禁止複製／列印／下載、閒置或離開視窗自動上鎖
  - 浮水印可以插入 `{收件人}` `{時間}` `{日期}` `{IP}` `{地區}` `{裝置}` `{編號}` `{備註}`；`{IP}`、`{地區}` 是伺服器看到的對外位址（只有線上模式有）
  - `{編號}` 是每次開啟隨機產生的代碼，線上模式會連同時間、IP 記在開啟紀錄裡，外流的截圖可以靠它查出是哪一次開啟
  - `{裝置}` 只有瀏覽器與作業系統；網頁讀不到電腦名稱或硬體資訊，要標示電腦名稱請填在收件人「備註」再用 `{備註}`
  - 浮水印被移除或隱藏時會自動上鎖
- 手機用 `/open.html` 開啟同一個檔案，解密只在手機上進行；金鑰可以按「📷 掃描 QR」用相機掃金鑰卡（在瀏覽器內解碼，不上傳）

## 安全設計

- 內容金鑰 = HKDF(Argon2id(密碼) ‖ 金鑰 ‖ 伺服器分片)，三樣缺一就解不開；伺服器自己也解不開
- 伺服器只存「驗證用金鑰」（由密碼和金鑰推導，無法反推回去），開啟時用一次性挑戰值加 HMAC 驗證
- 每個檔案各自用 AES-256-GCM 加密；檔名、收件人、使用條件都在加密的索引裡，竄改會被偵測
- 雲端連結：雲端空間只存密文；伺服器在開啟成功後才發一張 12 小時的「閱讀通行證」，憑它才能分段讀取，收回或刪除時立即作廢

已知限制：擋不住截圖和翻拍（所以有浮水印）；線上模式放行之後，懂技術的人可以把當下的內容存下來；
**離線模式的次數與期限可以被繞過**（換電腦、換瀏覽器、改時鐘），只能防君子，需要確實限制請用線上模式。

## 開發

```bash
npm install
npm test            # 單元測試（加密核心、封存格式、伺服器邏輯、設定值）
npm run test:e2e    # 建置後用 Chromium 實測檢視器、打包器與「網頁＋伺服器同網址」
npm run build       # dist/：index.html（打包器）、open.html（手機檢視頁）
npm run dev:worker  # 用 Cloudflare 的本機執行環境跑完整專案（在 .dev.vars 寫 ADMIN_PASSWORD=...）
```

## 結構

```
wrangler.jsonc  Worker 設定：伺服器程式 + ./dist 靜態網頁（這個資料夾就是完整的部署單位）
src/core/       加密、封存格式、金鑰文字、MIME（打包器與檢視器共用，有測試）
src/viewer/     檢視器：解鎖、樹狀列表、預覽、防護 → 建置成單一 HTML 模板
src/app/        打包器：伺服器精靈、建立精靈、管理頁、說明
src/shared/     共用樣式、DOM 工具、設定值（settings.ts）
server/src/     Worker 與 Durable Object（hub.ts 為不依賴 Cloudflare 的核心邏輯；cloud.ts 管理雲端空間設定與 Google 授權）
server/src/storage/  雲端空間 adapter：webdav.ts、s3.ts（含 AWS SigV4 簽章）、gdrive.ts；index.ts 登記可用的種類
scripts/        建置與部署腳本（settings.mjs 讀參數，deploy-ci.mjs 是部署器）
tests/          單元測試；tests/e2e/ 為瀏覽器端對端測試
```
