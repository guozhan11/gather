# Gather 开发文档

面向要运行、修改或部署 Gather 的人。使用方法见项目根目录的 [README](../README.md)。

## 本地运行

需要 Node.js 20 以上。

```bash
npm install
```

把 OpenAI API key 填进 `.env`：

```
OPENAI_API_KEY=sk-...
```

```bash
npm start
```

打开 http://localhost:3000 。

**没有 key 也能跑**：`OPENAI_API_KEY` 为空时自动进入演示模式，用一个简单的规则解析器代替 AI（只认识常见的中英文说法，比如"周四晚上7点以后"、"Friday after 7pm"），页面顶部会有提示。

可选配置（都在 `.env` 里）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OPENAI_MODEL` | `gpt-5.4-mini` | 使用的模型，需要支持 Structured Outputs |
| `OPENAI_REASONING_EFFORT` | `low` | 推理强度；换成不支持推理的模型（如 gpt-4.1）时留空 |
| `PORT` | `3000` | 端口 |
| `DEMO_MODE` | | 设为 `1` 时即使有 key 也强制使用演示模式 |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` | | 都填上时启动 Slack 机器人，见下文 |
| `PUBLIC_URL` | `http://localhost:3000` | 发给组织者的面板链接用的地址；部署到服务器后改成公网地址 |

## Slack 机器人

### 第一次设置（约 5 分钟）

1. 打开 https://api.slack.com/apps ，点 **Create New App** → **From a manifest**，选择你要装到的 workspace。
   > 建议先自己建一个测试 workspace。学校或实验室的 workspace 通常需要管理员批准才能安装应用。
2. 把项目里 [slack-manifest.yml](../slack-manifest.yml) 的全部内容粘贴进去，点 **Next** → **Create**。所有权限和设置会一次配好。
3. 左侧 **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**：名字随便填，添加 `connections:write` 这个 scope，生成后复制 `xapp-` 开头的 token。
4. 左侧 **Install App** → **Install to Workspace** → 允许，复制 `xoxb-` 开头的 **Bot User OAuth Token**。
5. 把两个 token 填进 `.env`：
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```
6. 重新运行 `npm start`。看到 `Slack bot connected (Socket Mode)` 就说明连上了。
7. 在 Slack 的任意频道里输入 `/gather` 试试。如果是私有频道，先用 `/invite @Gather` 把机器人拉进去。

机器人用的是 Socket Mode，通过你电脑上运行的服务器连接 Slack，不需要公网地址。代价是：**电脑上的 `npm start` 关掉之后，机器人也就下线了。** 要长期运行，需要部署到服务器上。

**隐私：** 机器人只读它自己发起的活动消息下面的回复，不读频道里的其他消息。

### 已经创建过应用，要更新配置（比如打开私聊）

1. 打开 https://api.slack.com/apps → 选择 Gather → 左侧 **App Manifest**。
2. 把 [slack-manifest.yml](../slack-manifest.yml) 的全部内容粘贴进去，替换原有内容，点 **Save Changes**。
3. 页面顶部会提示需要重新安装：左侧 **Install App** → **Reinstall to Workspace** → 允许。token 一般不会变；如果变了，把新的 `xoxb-` token 更新到 `.env`。
4. 重启 `npm start`。

## 部署网页版到 Cloudflare Workers

网页版可以部署到 Cloudflare Workers，得到一个任何人都能打开的网址（`https://gather.<你的子域名>.workers.dev`），不用在自己电脑上运行。Slack 机器人不在里面，它仍然靠本地的 `npm start` 运行。

结构：

- `public/` 里的页面作为静态文件托管；`/e/...` 这几个页面地址由 `worker.js` 映射到对应的 HTML。
- `/api/*` 由 `worker.js` 处理，跑的是和本地完全相同的 `lib/api.js`。
- **每个活动是一个 Durable Object**（`EventStore`），活动数据以 JSON 存在它自己的 SQLite 里。同一个活动的请求会排队依次处理，两个人同时提交不会互相覆盖。`lib/store.js` 根据运行环境选择存储：本地用 `data/db.json`，Cloudflare 上用 Durable Object。
- OpenAI key 存成 Cloudflare 的 secret，只在服务器上，浏览器拿不到。
- 调用 AI 的接口有限流：每个访客每分钟 20 次，全站每分钟 200 次（在 `wrangler.jsonc` 里调）。超过会返回 429。

第一次部署：

```bash
npx wrangler login
```

```bash
npx wrangler secret put OPENAI_API_KEY
```

（会提示你粘贴 key，key 不会出现在命令或代码里。）

```bash
npm run deploy
```

之后每次改了代码，再运行 `npm run deploy` 就行。

本地模拟 Cloudflare 环境：`npm run dev:worker`，打开 http://localhost:8787 。它会读取 `.env` 里的 OpenAI key，数据存在 `.wrangler/` 里。

注意：Cloudflare 上的数据和本地 `data/db.json` 是分开的，互不相通。

## Slack on Cloudflare：让任何 workspace 都能安装

部署在 Cloudflare 上的 Gather 同时也是一个可以公开安装的 Slack 应用。别的组织打开 `/slack`，点 **Add to Slack**，就能把 Gather 装进他们的 workspace。

**原理：**
- Slack 把事件、`/gather` 和按钮点击都发到 `/slack/events`。Worker 先验证签名，再交给这个 workspace 自己的 **Workspace Durable Object** 处理。
- 每个 workspace 一个 Durable Object，里面存它的 bot token、活动和成员偏好。所以不同组织的数据天然隔开，一个组织的私聊永远看不到另一个组织的活动。
- 机器人逻辑和本地版本是同一份（`lib/slack.js`）：本地用 Bolt 的 Socket Mode 跑（`lib/slack-socket.js`），Cloudflare 上用 `lib/slack-http.js` 跑。
- Slack 要求 3 秒内回应。Worker 会先回应，AI 解析这些耗时的工作在回应之后接着做。
- Slack workspace 的活动 id 是 `<teamId>.<id>`。网页面板链接 `/e/<teamId>.<id>/admin` 会被路由到对应 workspace 的 Durable Object。

**第一次设置：**

1. 在 Slack 后台打开 Gather → **Basic Information** → App Credentials，点 **Show** 复制 **Client Secret** 和 **Signing Secret**。Client ID 已经写在 `wrangler.jsonc` 的 `vars` 里了。
2. 在项目文件夹里把两个 secret 存进 Cloudflare（会提示你粘贴，不会显示在屏幕上）：
   ```bash
   npx wrangler secret put SLACK_CLIENT_SECRET
   npx wrangler secret put SLACK_SIGNING_SECRET
   ```
3. 部署：`npx wrangler deploy`。没设 secret 之前，`/slack/*` 会返回 503，网页版不受影响。
4. Slack 后台 → **App Manifest**，用 [slack-manifest.yml](../slack-manifest.yml) 替换全部内容并保存。Slack 会去验证 `/slack/events` 这个地址，所以要先完成第 2、3 步。如果部署地址不是 `gather.psc-docket-helper.workers.dev`，先把文件里的网址都改掉。
5. 打开 `https://<你的地址>/slack`，点 **Add to Slack**，把 Gather 装进**你自己的** workspace。这一步会把 token 存进 Cloudflare。之前 `.env` 里那个 token 只给本地版本用。
6. 要让别的组织也能装：Slack 后台 → **Manage Distribution** → 按清单逐项确认后，点 **Activate Public Distribution**。然后把 `https://<你的地址>/slack` 发给对方就行。

**本地开发：** 生产环境的应用改成 HTTP 之后就不再走 Socket Mode，本地 `npm start` 也就收不到它的消息了。想在本地调试 Slack，用 [slack-manifest.local.yml](../slack-manifest.local.yml) 另建一个 "Gather (dev)" 应用，把它的两个 token 填进 `.env`。

**本地测试 Cloudflare 版本：** `npx wrangler dev` 时加上 `--var SLACK_API_URL:http://127.0.0.1:<端口>/api/`，就可以把 Slack API 指向一个假的本地服务器，完整测试安装、`/gather`、表单、回复和私聊，而不碰真实的 Slack。

**频道消息怎么处理（lib/slack.js 的 message 处理）：**
- 活动帖子里的回复，以及挂在活动上的帖子里的回复：直接解析。
- 频道里 @Gather 的消息：算作对这个频道最新一个未关闭活动的回复（14 天内创建的）。
- 频道里没 @ 的消息：只有 `looksLikeReply()` 判断像在回复时（提到星期几、钟点，或者"今天/晚上"加上"可以/有空"这类词），才给发消息的人弹一个只有本人可见的"要算进去吗"提示，本人确认后才解析和保存。

**限制：**
- Slack 的一次请求之后，后续工作最多再运行约 30 秒。加很多虚拟回复、一次问很多人这类操作通常够用；如果以后操作变得更重，可以改用 Cloudflare Queues。
- 私聊里还没发布的草稿只存在内存里。Durable Object 闲置一段时间后会被回收，草稿就会丢失，这时需要重新说一遍。

## 设计要点：LLM 做理解，代码做计算

- `lib/llm.js`：调用 OpenAI，用 JSON Schema 结构化输出把自然语言转换成 `availability / hard_constraints / preferences / notes`；生成方案时**只能从算法给出的候选时段里选**（通过 `candidate_index` 引用），不会编造时间。
- `lib/schedule.js`：确定性的时间计算。一个时段只有被某人的某段空闲**完整覆盖**才算能来；排序时先看能来的人数，再看偏好加权分（preferred 1.0 / available 0.8 / if_needed 0.4），同一天重叠的时段会去重，保证候选方案确实不同。
- `lib/llm.js` 里的 `sanitizeParsed` 会裁掉活动日期和时间窗口之外的内容，防止模型输出出错影响计算。

## 项目结构

```
server.js            本地 Express 服务器（有 Slack token 时同时启动机器人）
worker.js            Cloudflare Workers 入口（网页版部署用），每个活动一个 Durable Object
wrangler.jsonc       Cloudflare Workers 配置
lib/api.js           网页版的 API，本地服务器和 Cloudflare Worker 共用
lib/slack.js         Slack 机器人逻辑：/gather、帖子回复、私聊、协商、生成方案、发布决定
lib/slack-socket.js  本地运行 Slack 机器人（Bolt，Socket Mode）
lib/slack-http.js    Cloudflare 上运行 Slack 机器人：验证签名、分发请求、API 客户端、安装授权
lib/web.js           网页版的一对一沟通：参与者私人页面上的追问、回答和更新
lib/simulate.js      测试用的虚拟参与者（包括他们怎么回答协商）
lib/negotiate.js     协商：该问谁、记录问答（Slack 和网页共用）
lib/events.js        创建活动的校验规则（网页和 Slack 共用）
lib/llm.js           OpenAI 调用与 prompt
lib/schedule.js      时段排名与热力图
lib/demoParser.js    无 key 时的规则解析器
lib/store.js         JSON 文件存储（data/db.json）
public/              五个页面：index（创建）、event（参与者）、me（参与者私人页面）、mine（My Gather，/me）、admin（组织者）
test/                单元测试（npm test），包括用模拟 Slack 跑通整个机器人流程
slack-manifest.yml   Slack 应用配置，创建应用时直接粘贴
```

## 网页版的一对一沟通

Slack 版靠私聊找到每个人，网页版靠**私人链接**：

- 参与者在 `/e/:id` 提交后，服务器给这条回复生成一个随机 `token`，私人页面是 `/e/:id/me/:token`。浏览器会把 token 存进 localStorage，所以同一台设备再打开活动链接时会提示"欢迎回来"。带着 token 重新提交会更新同一个人的回答（可以改名），不会新增一条。
- 组织者点协商按钮时（`POST /api/events/:id/negotiate`），网页参与者的问题写进 `response.thread` 和 `response.negotiation`，同时在 `event.negotiationLog` 里记一条 `kind: "web"`。虚拟参与者还是当场回答。
- 参与者在私人页面上点 Yes/No（`/me/:token/answer`），或者打字（`/me/:token/message`，走和第一次回复一样的解析）。打字回答后会检查新的空闲时间是否覆盖那个时段，自动标成 `yes` 或 `replied`。
- 浏览器用 `gather-token-<活动编号>` 记住每个回复过的活动，一台设备可以记住很多个。`/me`（`public/mine.html`）读出这些记录，逐个请求私人页面接口，汇总显示；失效的记录会自动删掉。没有账号，服务器也不额外存任何东西。
- 私人页面每 15 秒刷新一次；组织者面板在有人还没回答时每 20 秒刷新一次。
- `POST /api/events/:id/announce` 定下方案后，活动和私人页面都显示最终安排，解析和提交接口返回 409。
- 组织者面板里的回复列表不包含 token 和对话原文，只给出每个人的私人页面路径，方便组织者复制提醒。

## MVP 的已知限制

- 数据存在本地 JSON 文件里，没有账号体系；组织者权限只靠链接里的 key。
- 所有时间都按活动创建者的时区处理，参与者在其他时区时需要按组织者时区来描述。
- 演示模式的规则解析器很粗糙，只用来演示流程；真实效果需要填 API key。
- Cloudflare 版有基本限流，但没有 Turnstile 之类的人机验证；链接被大量转发时，还是会产生 AI 费用。
- 网页版不能主动通知参与者有新问题，需要组织者把提醒复制给对方。可以接邮件或短信通知（参与者已经能留联系方式）。
- 私人链接就是凭证，谁拿到链接谁就能改这个人的回答。

## 下一步可以做的

- 部署（Render / Railway / Fly.io），让链接在群里真正能打开
- 日历同步（Google Calendar 的空闲/忙碌信息）
- 多时区支持
- 根据偏好推荐具体餐厅或场地（接入地图或点评类 API）
- 用真实活动做小规模对比实验：效率、信息完整度、满意度、解析准确率
