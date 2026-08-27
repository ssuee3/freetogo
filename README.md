# FreeGameHost 自动续期

用 [puppeteer-real-browser](https://github.com/zfcsoftware/puppeteer-real-browser) 驱动真实 Chrome，自动为 [FreeGameHost](https://panel.freegamehost.xyz)（Pterodactyl 面板）的免费服务器点击 **RENEW +8 HOURS** 续期，跑在 GitHub Actions 上，每 3 小时一次，结果推送到 Telegram。

## 工作流程

```
注入会话 cookie → 打开服务器页 → 关掉 cookie 同意弹窗
  → 点 RENEW +8 HOURS → 等 Cloudflare Turnstile（compact/auto）求解
  → 检测续期成功/冷却 → Telegram 通知 + 截图
```

- **登录**：优先复用 `SESSION_COOKIES` 里的已登录会话，绕开登录页的 reCAPTCHA v3 风控；cookie 失效时回退 `EMAIL` / `PASSWORD` 账号密码登录。
- **Turnstile**：站点用的是 compact + auto 控件（iframe 在 shadow DOM 里）。脚本先等 auto 自动求解，拿不到 token 再把控件滚进视口、点一次勾选框，避免连点打断验证。
- **冷却识别**：处于续期冷却期时不会误点，直接上报冷却剩余时间。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `SESSION_COOKIES` | 二选一 | 已登录会话 cookie，支持 Cookie header 字符串或 Chrome 导出的 JSON 数组 |
| `EMAIL` | 二选一 | 登录邮箱（cookie 失效时回退用） |
| `PASSWORD` | 二选一 | 登录密码 |
| `SERVER_ID` | 否 | 服务器短 ID，默认 `09758a67` |
| `IS_PROXY` | 否 | `true` 时挂代理，默认 `false` |
| `PROXY_SERVER` | 否 | 代理地址，默认 `socks5://127.0.0.1:1080` |
| `TG_BOT_TOKEN` | 否 | Telegram bot token，配置后推送通知 |
| `TG_CHAT_ID` | 否 | Telegram chat id |

> `SESSION_COOKIES` 与 `EMAIL`+`PASSWORD` 至少提供一组。推荐用 `SESSION_COOKIES`，最稳定。

<!-- APPEND-MARKER -->
### 获取 SESSION_COOKIES

1. 本地浏览器正常登录 `https://panel.freegamehost.xyz`。
2. 打开 DevTools → Application → Cookies → 选中该域名。
3. 复制关键 cookie，拼成一行（`remember_web_*` 一起带上更稳）：

   ```
   pterodactyl_session=xxx; XSRF-TOKEN=xxx; remember_web_xxx=xxx
   ```

   也可直接粘贴 cookie 导出扩展生成的 JSON 数组（含 `name` / `value` / `domain` / `expirationDate` 等字段）。

## 本地运行

需要本机已安装 Google Chrome（`/usr/bin/google-chrome`）与 Node 20+。

```bash
npm install

# 用环境变量或 .env 提供上表变量后运行
SESSION_COOKIES='pterodactyl_session=...; XSRF-TOKEN=...' node renew-freegamehost.js
```

Linux 无显示环境下用 Xvfb（浏览器以非 headless 模式启动，需要虚拟显示）：

```bash
xvfb-run -a node renew-freegamehost.js
```

运行截图与失败诊断图输出到 `artifacts/`。

## 运行测试

纯函数（cookie 解析、Turnstile 点击点计算、通知格式化等）有单元测试：

```bash
npm test        # 或 node --test renew-freegamehost.test.js
```

## GitHub Actions

工作流位于 [`.github/workflows/renew-freegamehost.yml`](.github/workflows/renew-freegamehost.yml)：

- **触发**：每 3 小时定时（`cron: '0 */3 * * *'`，UTC 整点），也可在 Actions 页手动 `workflow_dispatch`。
- **配置**：在仓库 `Settings → Secrets and variables → Actions` 添加上表所需的 secrets（`SESSION_COOKIES` 或 `EMAIL`+`PASSWORD`，以及可选的 `TG_*`、代理相关 `NODE_LINK`）。
- 每次运行会清理旧的运行记录，只保留最近一次。

> 续期冷却为 2 小时，3 小时一次的节奏通常能稳定续上，不会长期撞冷却。

## 文件说明

| 文件 | 作用 |
|------|------|
| `renew-freegamehost.js` | 主脚本：登录、续期、Turnstile、通知 |
| `renew-freegamehost.test.js` | 纯函数单元测试（`node:test`） |
| `.github/workflows/renew-freegamehost.yml` | 定时/手动触发的 CI 工作流 |

## 说明

仅用于自动续期个人名下的免费服务器。请遵守 FreeGameHost 的服务条款，勿滥用。

