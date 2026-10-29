# 隨身密閱 企劃書（v1，已定案）

## 1. 目標

- 把多個文件（含資料夾結構）加密成**一個 `.html` 檔**，檢視器內嵌其中，收件人不必安裝任何東西。
- 開啟需要：**密碼**（知道的）＋**金鑰**（持有的）＋（線上模式）**伺服器放行**。
- 檔案總管式介面：左側樹狀列表＋搜尋，右側內容預覽。
- 每份封存檔可各自設定：期限、次數、浮水印、禁止複製／列印／下載、閒置上鎖、錯誤鎖定。

## 2. 決策紀錄

| # | 議題 | 決定 | 理由（含查證） |
|---|---|---|---|
| D1 | 用途 | 自用備份＋分享給他人限制對方，兩者都要 | |
| D2 | 型態 | 單一 `.html` | 實測 Chromium 以 `file://` 開啟時 `isSecureContext=true`、WebCrypto 與 localStorage 可用；免安裝、跨平台、不會被當成可疑執行檔 |
| D3 | 限制強度 | **一開始就做線上強制**，每份打包時可改選離線 | 離線限制只能防君子；線上由伺服器把關才能真正強制次數、期限並遠端收回。自用備份可選離線，以便沒網路時使用 |
| D4 | 伺服器 | Cloudflare Workers＋Durable Objects（SQLite） | 免費方案每天 10 萬次請求、計數強一致、不會休眠。Supabase 免費專案閒置 7 天會暫停，不適合 |
| D5 | 裝置 | 電腦為主；手機改用 GitHub Pages 上的檢視頁開同一個檔案 | iPhone「檔案」App 開本機 HTML 多半只是預覽、不執行 JS；檢視頁在手機本機解密，檔案不上傳 |
| D6 | PPT | 使用者先用 PowerPoint「匯出 PDF」；打包器偵測到 .pptx 會提醒；可勾選「PDF 轉逐頁圖片」 | LibreOffice 自動轉換常有中文字型被替換、表格與背景跑掉的問題；PowerPoint 自己匯出最準確、文字可搜尋、檔案小。轉圖片可防選取複製文字，代價是檔案變大、無法搜尋 |
| D7 | 大小 | 單份建議 ≤ 300MB，超過就警告；影片先壓縮 | 單一 HTML 開啟時會整個載入記憶體 |
| D8 | 多位收件人 | 每人一份獨立副本 | 各自的金鑰、次數、浮水印名稱，可單獨收回，外流時能追查來源 |
| D9 | 金鑰形式 | 同一把金鑰可輸出成 `.key` 檔、分組文字、QR Code | 收件人用任一種都能解鎖 |
| D10 | 打包／管理 | 一個網頁同時負責打包與管理（GitHub Pages，也可下載到本機使用），用管理員密碼登入 | 加密都在本機完成，只有伺服器那份金鑰和使用條件會上傳，文件本身不上傳 |
| D11 | 防護 | P0 全部都做，每份封存檔可個別開關與調整參數 | 浮水印、禁止複製／列印／下載、閒置上鎖、密碼錯誤鎖定 |

## 3. 已知限制（要讓使用者知道）

1. **擋不住截圖和翻拍**：只能靠浮水印（收件人＋時間）嚇阻並追查來源。
2. **線上模式擋得住「之後」的開啟，擋不住「這一次」的存檔**：伺服器放行後，內容就在瀏覽器裡，懂技術的人可以當下把內容存下來。期限到了或收回之後，就再也打不開。
3. **離線模式只能防君子**：調時鐘、換瀏覽器、複製檔案都能繞過次數和期限。
4. **不要用 Email 附件寄送**：「HTML 裡藏加密資料」的做法和惡意程式（HTML smuggling）很像，公司信箱可能會擋下或隔離。建議用雲端連結或隨身碟傳送封存檔，金鑰和密碼再用其他管道給。

## 4. 架構

```
┌──────────────┐  只上傳伺服器分片＋使用條件   ┌──────────────────────┐
│ 打包＋管理頁  │ ───────────────────────────▶ │ Cloudflare Worker     │
│ (GitHub Pages)│ ◀── 開啟紀錄／收回／延長 ──── │ ＋ Durable Object/份  │
└──────┬───────┘                               └──────────▲───────────┘
       │ 輸出 xxx.vault.html（每位收件人一份）            │ 證明＋要分片
       ▼                                                  │
┌──────────────┐   雙擊用瀏覽器開，或用手機檢視頁開         │
│ 封存檔＝檢視器 │ ─────────────────────────────────────────┘
└──────────────┘
```

### 4.1 金鑰推導
- `pwKey = Argon2id(密碼, salt, 64MiB, t=3)`（內嵌 hash-wasm，體積很小）
- `keyfile` = 32 bytes 隨機值；文字形式是分組 Base32 加檢查碼，也可輸出 QR
- `serverShare` = 32 bytes，只存在伺服器（離線模式沒有這一份）
- `authKey = HKDF(pwKey‖keyfile, "auth")`：用來向伺服器證明持有密碼和金鑰。伺服器只存 authKey，無法反推出密碼或金鑰
- `contentKey = HKDF(pwKey‖keyfile‖serverShare, "content")`：三樣缺一就解不開
- 結果：只有檔案打不開；伺服器自己也打不開；收件人沒有伺服器放行也打不開

### 4.2 封存檔格式
- 明文表頭：格式版本、vaultId、伺服器網址、salt、模式（線上／離線）。都不是秘密
- 加密索引（manifest）：檔名、資料夾結構、收件人名稱、防護參數。沒解鎖連檔名都看不到；被竄改時 GCM 驗證會失敗
- 每個檔案各自用 AES-256-GCM 加密（金鑰由 HKDF(contentKey, fileId) 產生），點到才解開
- 資料以 base64 分段嵌入 HTML

### 4.3 線上開啟流程
1. 檢視器向伺服器要一個一次性挑戰值 nonce
2. 檢視器送出 `HMAC(authKey, nonce)`
3. 伺服器依序檢查：是否已收回 → 期限（以伺服器時間為準）→ 剩餘次數 → 錯誤鎖定
4. 通過就回傳 serverShare、次數減一並寫入開啟紀錄（時間、IP 所在地區、瀏覽器）；失敗就累計錯誤次數
5. 閒置上鎖會清掉記憶體裡的金鑰；在同一段瀏覽期限內重新輸入密碼解鎖，不重複計次（伺服器發有時效的 session）

### 4.4 每份封存檔的可調參數
| 參數 | 說明 |
|---|---|
| 模式 | 線上（預設）／離線 |
| 生效日、到期日 | 線上以伺服器時間為準 |
| 可開啟次數 | 不限或 N 次 |
| 密碼錯誤上限 | N 次後鎖定，可在管理頁解除 |
| 浮水印 | 開關、文字範本（{收件人} {時間}）、透明度 |
| 允許複製文字／列印／下載原檔 | 各自開關 |
| 閒置上鎖 | N 分鐘無操作；切到其他視窗超過 N 秒 |

### 4.5 預覽支援
- PDF：pdf.js；圖片：原生；文字／Markdown／程式碼：內建
- 影片／音訊：原生 `<video>`／`<audio>`（建議 MP4 H.264）
- Word：docx-preview；Excel：SheetJS 表格（版面要求高的建議先轉 PDF）
- PPT：請先匯出 PDF；不支援的類型顯示檔案資訊，依設定決定能否下載

### 4.6 管理頁功能
- 管理員登入（密碼存在 Worker secret，有登入失敗限制）
- 打包：拖入檔案／資料夾 → 設定參數 → 填收件人清單 → 每人產生 `.vault.html` 與金鑰（檔案／文字／QR）
- 管理：封存檔清單、各收件人剩餘次數、開啟紀錄、延長期限、增加次數、解除鎖定、**立即收回**

## 5. 階段

- **P0（核心）**：加密核心與測試、封存檔格式、檢視器（線上＋離線、樹狀列表、PDF／圖片／文字／影音預覽、全部防護）、Worker＋Durable Object、打包＋管理頁、每人獨立副本、金鑰三種形式
- **P1**：Word／Excel 預覽、PDF 轉逐頁圖片、手機檢視頁、管理頁的統計圖表
- **P2**：視需求加入大檔外存（R2）、裝置綁定、通知（有人開啟時推播）

## 6. 開始前需要使用者準備

1. 註冊 Cloudflare 免費帳號
2. 建立 API Token（權限：Workers Scripts 編輯、Durable Objects），並把 Token 和 Account ID 存到 GitHub repo 的 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`
3. 設定管理員密碼（之後我會提供設定指令，密碼不寫進程式碼）

在帳號準備好之前，可以先用 `wrangler dev` 在本機模擬伺服器，開發不受影響。

## 7. 參考資料

- Cloudflare Durable Objects 價格與限制：https://developers.cloudflare.com/durable-objects/platform/pricing 、https://developers.cloudflare.com/durable-objects/platform/limits
- Supabase 免費專案閒置暫停：https://www.productcompass.pm/p/supabase-project-paused
- iOS 本機 HTML 不執行 JS：https://developer.apple.com/forums/thread/86485
- HTML smuggling：https://www.microsoft.com/en-us/security/blog/?p=101403
- LibreOffice 轉 PPTX 字型問題：https://ask.libreoffice.org/t/font-lost-after-converting-ppt-to-pdf/61262
- StatiCrypt 的限制（可對照）：https://www.peony.ink/blog/how-to-password-protect-html-file
