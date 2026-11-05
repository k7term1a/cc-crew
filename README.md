# cc-sticky-notes

一個 Claude Code mod，做兩件事：

- **session 角色**：幫一個專案的幾個 session 分工。一個 main 和你討論，從它 fork 出來的 sub 負責實作，另開的統整 session 只讀專案文件來回答。見下方「session 角色」。
- **便利貼**：在專案 session 裡想問的「為什麼 / 這是什麼」，用 `/sn new` 開成「便利貼」，不進主線對話，在背景回答、顯示在右側 pane，並存成一棵同專案所有 session 共用的樹。主線的 context 保持乾淨，追問也能一路掛在同一條旁支下。

版本 0.0.4，給朋友試用中。設計與決策：[PLAN.md](PLAN.md)；Mods API 實測紀錄：[PROBE.md](PROBE.md)；之後可能做的需求：[REQUESTS.md](REQUESTS.md)。

**11/05 改版**：每句送 Jev 分流（便利貼對話框）、規範提醒、背景統整（主線摘要、專案脈絡）都拿掉了，原因見 [PLAN.md](PLAN.md)「11/05 改版」。下面各版的紀錄裡提到的這些功能和指令已經沒有了。改成 session 角色：新 session 的第一句送 Jev 判斷一次，fork 自動標成 sub，`/sn tag` 手動標。

**0.0.4 新的地方**

- 多台電腦同步（選用）：便利貼透過你自己的 Notion 資料庫在電腦之間同步，見下方「在多台電腦之間同步」。
- 卡片時間前面有底色的類別標籤：Jev 對這個主題的判斷（知識旁問、專案疑問、主線任務）。
- 刪除便利貼：問題旁的 ✕ 或 `/sn rm`，只刪這台電腦的。
- Jev 的對話框 30 秒沒回應就自動送進主線（`/sn timeout <秒>` 調整，0 一直等）。對話框本身會留在畫面上，關掉就好。
- 拿掉「結束追問」按鈕（改用 `/sn back`）；舊的「這題在主線回答」便利貼會在開 session 時自動清掉。
- `/sn provider`、`/sn every`、`/sn notion` 的設定改存在每台電腦自己的資料裡（之前在 Desktop 會設定失敗）。

**0.0.3 新的地方**

- pane 改成卡片：一個主題一張卡，點開是一段對話（問題像 prompt 泡泡、答案在下面），多個追問用按鈕切換，卡片最下面直接回覆；滑鼠移到問題旁的 ✎ 可以換個問法再問一次。正在追問的那張是綠框。
- 主線摘要與專案脈絡：每 3 個主線回合在背景統整一次（第一次讀整個 session），Jev 判斷時會參考；pane 最下面的「專案脈絡」卡片可以看、刪、加，或按「立即統整」。
- 新指令：`/sn provider claude|openai` 切換統整層、`/sn every <n>` 調整統整頻率（0 關閉）、`/sn ctx` 看與編輯專案脈絡。
- OpenAI 的 `redacted` 模式現在真的會先剝掉程式碼、路徑、金鑰再送出（之前沒有）。

**0.0.2 新的地方**

- 對話框的〔接在「…」下〕改成 Jev 判斷最相關的那張便利貼（從最近 8 張裡挑），不再只能接目前追問的那張；多一個〔接在其他便利貼下…〕可以自己挑；在「其他」打標題的關鍵字也能找到便利貼。
- 從另一台電腦或手機（Remote Control）打字不會跳便利貼的對話框，一律進主線。
- Jev 判成「專案問題」的句子只進主線，不再在 pane 留下「在主線回答」的便利貼。
- pane 的追問框送出後會清空。
- 輸入框下方的狀態列改成顯示這個 mod 今天用掉的額度（Jev 次數、Claude / OpenAI token）。

## 需求

- Claude Code **2.1.288 以上**（Mods 是 early access，在 2.1.288 / 2.1.289、Windows 的 Claude Desktop Code 分頁與終端機測過）。
- 選用：TypeSafe 的 Jev API key（判斷新 session 的第一句）、OpenAI API key（統整層可改用 OpenAI）。沒有也能用，見下方「金鑰」。

## 安裝

```bash
git clone https://github.com/k7term1a/cc-sticky-notes.git
```

**終端機**：每次啟動時帶上資料夾路徑。

```bash
claude --plugin-dir /path/to/cc-sticky-notes
```

**Claude Desktop（Code 分頁）**：在 `~/.claude/settings.json` 的 `env` 加上這個資料夾，之後開的 session 都會載入。

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\you\\cc-sticky-notes",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

- 改完要**開新的 session**（已經開著的 session 不會重新讀設定）。
- `CLAUDE_CODE_PLUGIN_DIR_WATCH` 是選用的：設了之後，mod 的檔案一更新（例如 `git pull`），開著的 session 就會自動重載。
- 裝好後在輸入框下方右側會看到 `cc-sticky-note`。打 `/sn doctor` 可以檢查金鑰有沒有讀到。

## 金鑰（選用）

建一個 `~/.claude/sticky-notes/.env`（Windows 是 `C:\Users\<你>\.claude\sticky-notes\.env`）：

```
TYPESAFE_API_KEY=apikey_...
OPENAI_API_KEY=sk-...
```

- 依序找：環境變數 → `~/.claude/sticky-notes/.env` → mod 資料夾裡的 `.env`。**不會讀你專案自己的 `.env`**（那裡常有那個專案自己的 OpenAI key）。
- 金鑰值不會被印出、記錄或存進 store；`/sn doctor` 只告訴你找到沒有、從哪裡找到。
- **沒有 Jev key**：新 session 的第一句不會被判斷，也不會跳角色的對話框；要標角色就打 `/sn tag`。
- **沒有 OpenAI key**：完全不影響，預設本來就用 Claude（你登入的訂閱）寫標題和摘要。

## 怎麼用

### session 角色

一個專案分三種 session：

| 角色 | 做什麼 | 怎麼標 |
| --- | --- | --- |
| **main** | 和你討論；要實作時用 SendMessage 交給 sub；把 sub 回報的結果整理進紀錄檔（只有 main 寫紀錄檔） | 新 session 的第一句貼上專案啟動的上下文（目標、背景、計畫、限制），mod 問你要不要讓它共同管理，選「要，標成 main」，再選名稱和文件路徑 |
| **sub** | 做 main 交代的實作，結果寫進進度檔（一行一個 JSON）和證據資料夾，做完回報 main；不改紀錄檔 | 在 Desktop 從 main fork 一個 session，mod 在它開始時自動標成 sub，不問 |
| **統整** | 只讀紀錄檔、進度檔、證據資料夾來回答，每個說法附上出處；文件沒寫的回答「文件裡沒有」，並把缺的寫進專案根目錄的 `GAPS.md` | 開一個新的 session（不 fork），第一句請它統整或報告進度，mod 問你要不要標成統整、屬於哪一個 main |

- 判斷第一句要 Jev key，每個新 session 只送一次；之後的句子都不送。判成其他、Jev 沒回應、沒有 key，都不跳對話框，那句照常送出。
- 對話框 60 秒沒回答、或被關掉，就當作「不用」，那句照常送出。對話框會留在畫面上，關掉就好。
- 文件路徑預設 `RECORD.md`、`progress.jsonl`、`evidence/`，或 `docs/` 底下的同名檔；在「其他」依序打三個路徑、用逗號分開可以自訂。路徑都相對於專案根目錄。
- 標好角色後，那個 session 的下一句會帶上這個角色的工作規則（只帶一次，你看不到，Claude 讀得到）。sub 的下一句通常是 main 用 SendMessage 送來的那句。
- `/sn tag`：手動標、改標或清除（main / sub / 統整 / 清除），沒有 Jev key 時用這個。標 sub 或統整要先有 main。
- 簡報類 skill（`research-report-writing`、`deckframes`、`pptx`、`docx`、`docs`）只放在統整 session 的 skill 清單裡；其他 session（包括沒標角色的）要用就手打 `/名字`。名單是 plugin 的選項 `deckSkills`。一個 session 送出過請求後才改角色，清單不會回頭改（改了會讓快取失效）。

### 開一張便利貼

打 `/sn new <問題>`。這個問題不會進主線（指令紀錄裡的問題會被遮掉，Claude 讀不到），右上角跳一個通知，例如「cc-sticky-note：便利貼「CRDT 是什麼？」」；幾秒後答案出現在右側 pane（會自動打開），對話裡留一行灰字預覽，灰字 Claude 也讀不到。

你在輸入框打的每一句都照常進主線，mod 不會攔。

### 追問

用 pane 卡片最下面的回覆框，接在卡片目前讀到的最後一則下面。想結束追問，打 `/sn back`。

### 狀態列

輸入框下方右側的狀態列先顯示這個 session 的角色（`main「名稱」`、`sub ← main 的名稱`、`統整 ← main 的名稱`，沒標就不顯示），再顯示這個 mod 今天用掉的額度，例如 `cc-sticky-notes  今日 Jev 0 次 · Claude 35k`（用過 OpenAI 才會出現 OpenAI；Claude 的數字不含讀 cache 的部分；所有專案、所有 session 合計，每天歸零），還有幾則正在回答。

### 右側 pane

打 `/sn` 開關。內容：

- **一個主題一張卡片**，最新的在最上面。收合時只有一行：標題、時間、這個主題共幾則（標題後的 `…` 表示還在回答）。點那一行就展開，點展開後的標題就收合。
- **展開後是一段對話**：你的問題畫成像 Desktop prompt 的泡泡（靠右），答案接在下面，不分層級。某則有多個追問時，答案下面列出各追問的標題（`●` 是目前讀的這條、`○` 是其他），點了就換成那條往下讀。答案不是看得到專案的 Claude 回答時，下面會標「無專案脈絡」。
- **刪除**：滑鼠移到問題那一列，左邊的 `✕` 會先問一次，再刪掉那則和它底下的追問。只刪這台電腦的；有同步到 Notion 的會在 Notion 勾上「不同步」，其他電腦之後就不會再下載它（已經下載過的不會被刪）。也可以先點開那則，再打 `/sn rm`。
- **改寫問題**：滑鼠移到問題那一列，左邊會出現 `✎`；改完按 `↵` 會在同一層多一個追問（改的是第一個問題就開一張新卡片），舊的留著，可以用上面的 `●` / `○` 切換。
- **回覆框**：卡片最下面，接在目前讀到的最後一則下面。Desktop 的輸入框寬度固定，mod 改不了。
- **設定卡片**：pane 最下面的「設定」，點開可以切換答案回來時打開 pane、統整層（Claude / OpenAI）、Notion 同步。只影響這台電腦，按一下換到下一個值。下面列出只有統整 session 看得到的 skill（在 plugin 的選項 `deckSkills` 改）。
- **類別**：時間前面有底色的小標籤，是 Jev 對這個主題第一句的判斷（知識旁問、專案疑問、主線任務）。只有 11/05 以前經過 Jev 分流的便利貼有；用 `/sn new` 或回覆框建的沒有類別。
- **綠色邊框**：這個 session 正在追問的那張；其他卡片都是灰框。只是點開來看不會變成追問中。想結束追問打 `/sn back`。

### 在多台電腦之間同步（Notion，選用）

每台電腦的便利貼可以同步到你自己 Notion 裡的一個資料庫：答好的便利貼自動上傳一列；session 開始時把其他電腦在**同一個專案**做的便利貼拉下來（專案用 git remote 對應，路徑不同也沒關係）。走的是你在 claude.ai 連好的 Notion connector，mod 不存任何 token。

1. 在 Notion 建一個資料庫，欄位：標題（title）、問題、摘要、Note ID、上一層（文字）、專案、電腦、回答者（select）、建立時間（date）。
2. 在 `~/.claude/settings.json` 的 `permissions.allow` 加上 Notion connector 的四個工具：`notion-fetch`、`notion-query-data-sources`、`notion-create-pages`、`notion-update-page`（完整名稱是 `mcp__<connector id>__notion-fetch` 這種形式，`/sn notion test` 會印出 connector id）。沒加的話，auto 權限模式會擋下 mod 的呼叫。
3. 每台電腦各打一次 `/sn notion <collection://…>`，再打 `/sn notion test` 確認四步都 ✓。

| 指令 | 作用 |
| --- | --- |
| `/sn notion` | 看同步到哪、上次同步的結果 |
| `/sn notion pull` | 現在就下載其他電腦的便利貼 |
| `/sn notion push` | 把這個專案還沒上傳的便利貼全部上傳（第一次設定時用） |

只會新增，不會合併同一張便利貼的修改。

### 指令

`/sn` 和 `/sticky-note` 完全一樣，`/sn` 比較好打。

| 指令 | 作用 |
| --- | --- |
| `/sn` | 開 / 關右側 pane |
| `/sn tag` | 標這個 session 的角色：main、sub、統整，或清除 |
| `/sn new <問題>` | 開一張便利貼 |
| `/sn back` | 結束追問，回到主線 |
| `/sn rm` | 刪除 pane 裡點開的那則便利貼和它底下的追問（會先問） |
| `/sn provider claude\|openai` | 切換標題、摘要用誰寫（不帶參數就顯示目前用哪個） |
| `/sn notion …` | Notion 同步，見上一節 |
| `/sn doctor` | 檢查兩把金鑰找到沒有、從哪裡找到 |

### 設定

下列欄位可以在 Claude Code 的設定選單（`/config`，終端機）調整：

| 欄位 | 預設 | 說明 |
| --- | --- | --- |
| `autoOpenPane` | `true` | 答案回來時自動打開 pane 並選中 |
| `summaryProvider` | `claude` | 標題、摘要用誰寫：`claude` 或 `openai`（也可以用 `/sn provider`） |
| `claudeModel` / `claudeEffort` | `haiku` / `low` | 寫標題摘要的 Claude 模型與 effort（旁答本身一律用主線的模型） |
| `openaiModel` / `openaiReasoningEffort` | `gpt-5-mini` / `minimal` | `summaryProvider = openai` 時用 |
| `deckSkills` | `research-report-writing, anthropic-skills:deckframes, anthropic-skills:pptx, anthropic-skills:docx, anthropic-skills:docs` | 只有統整 session 的 skill 清單保留的 skill，逗號分開 |

## 已知限制

- 旁答用的是主線同一個模型（Claude Code 的限制），算在你的訂閱用量裡；有 prompt cache，通常 1–3 秒。
- 剛重開或 resume 一個 session、主線還沒跑過任何回合之前，旁答拿不到專案脈絡，pane 會標「無專案脈絡」。
- 便利貼存在本機：`~/.claude/plugins/store/cc-sticky-notes_*.json`。用 `--plugin-dir` 載入和正式安裝可能是不同的檔。
- 側邊欄外觀還很陽春，下一版會改。

## 開發

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
npx -p typescript@5.6 tsc -p .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`，那是引擎載入 mod 時寫出來的型別（已 git-ignore），所以第一次 type-check 前要先載入一次 mod。

- `hooks/register.tsx`：所有 hook，以及 `portsOf($)`。只有這個檔碰 `$`（PROBE.md P1）。
- `hooks/tree.ts`、`jev.ts`（只剩呼叫 Jev 的通道）、`redact.ts`、`digest.ts`、`answer.ts`：邏輯模組，純函式或吃 `Ports`。
- `hooks/notes.ts`：流程（便利貼 → 背景回答 → Notion 同步）。
- `hooks/roles.ts`：session 角色（第一句的判斷與對話框、fork 標成 sub、工作規則、skill 清單、`/sn tag`）。每個 session 一個 key：`role:<專案>:<session id>`。
- `hooks/secrets.ts`：金鑰從哪裡來。
- `hooks/pane.tsx`：右側 pane 與輸入框下方的狀態列。
- `probes/m0/`：M0 探針 mod（`cc-sticky-probe`），獨立的 plugin。
