# Telegraph-Image 私有图床 · 部署文档

> 本文档记录 2026-10 生产部署的实际拓扑、验收结果与运行手册。所有条目均经线上验证，非规划稿。

## 1. 部署概览

| 项 | 值 |
|---|---|
| Pages 项目 | `telegraph-image`（账户：賈松記 `9fa569b3…`） |
| 生产域名 | `https://t.rcrc.eu.org`（自定义域，证书 active）+ `https://telegraph-image-44h.pages.dev` |
| 代码源 | GitHub `jiasongji/Telegraph-Image` `main` 分支，push 自动构建（Build system v3，读取 `wrangler.toml`） |
| 存储 | Telegram Bot API（`STORAGE_PROVIDER=telegram`）；R2 `img_r2` 仅作备用绑定，未启用双写 |
| 审核 | Workers AI（`MODERATION_PROVIDER=cloudflare-ai`，绑定 `AI`） |
| KV | `img_url` → namespace `ad326d0091b24d4cbc40098e53e85432`（文件列表元数据） |

## 2. 访问控制（Cloudflare Access，Zero Trust）

私有应用双重准入（满足其一），会话 24h：

| 应用 | 作用域 | 策略 |
|---|---|---|
| Telegraph Image Private | `t.rcrc.eu.org`、`telegraph-image-44h.pages.dev` | ① Owner email（`jiasongji@gmail.com`，Allow）② Uploader service token（Service Auth / non_identity） |
| Telegraph Image Public Files | 两域名 `/file/*` | Bypass（everyone）——直链免登 |
| Telegraph Image Public Block Page | 两域名 `/block-img.html`、`/block-img` | Bypass——拦截页免登 |
| Telegraph Image Public Whitelist | 两域名 `/whitelist-on.html`、`/whitelist-on` | Bypass——白名单提示页免登 |

注意：Pages 会把 `/xxx.html` 308 到无后缀 `/xxx`，因此静态页的 Bypass 必须同时覆盖两种路径。

服务 Token 名称：`telegraph-image-uploader`（policy `Uploader service token`）。调用方式：请求头 `CF-Access-Client-Id` + `CF-Access-Client-Secret`。

⚠️ rcrc.eu.org zone 内有监控、网盘等其它业务的 DNS 记录与 Worker 路由，**任何 Access/DNS 变更前先核对作用域，严禁覆盖主域**（历史事故：私有应用曾误配整域 `rcrc.eu.org`，导致 CF-Monitor 全站 302 与探针 WebSocket 中断）。

## 3. 环境变量与密钥

生产环境（`wrangler.toml [vars]` + 加密 Secret）：

| 变量 | 类型 | 值 |
|---|---|---|
| `STORAGE_PROVIDER` | text | `telegram` |
| `MODERATION_PROVIDER` | text | `cloudflare-ai` |
| `SITE_BACKGROUND` | text | `/bg.svg` |
| `TG_Chat_ID` | text | 部署频道/群 ID（负数） |
| `TG_Bot_Token` | **secret** | （加密存储，不落仓库） |

轮换 Bot Token：

```bash
npx wrangler login   # 如未登录
npx wrangler pages secret put TG_Bot_Token --project-name telegraph-image
git commit --allow-empty -m "chore: retrigger deployment" && git push   # Secret 随下次部署生效
```

## 4. DNS

zone `rcrc.eu.org` 中仅新增一条（其余记录属其它业务，勿动）：

```
t.rcrc.eu.org  CNAME  telegraph-image-44h.pages.dev  (proxied)
```

## 5. 存储与审核流程

- **上传**：登录用户（或持 Service Token）`POST /upload`（multipart 字段 `file`）→ 经 Bot API 转存 Telegram → 返回 `[{src:"/file/<telegram_file_id>.png"}]`。
- **访问**：`/file/<id>` 公开免登。首次访问触发 Workers AI 审核（模型链：`@cf/meta/llama-3.2-11b-vision-instruct` → `@cf/llava-hf/llava-1.5-7b-hf`，动态目录缓存在 KV `moderation:live-models`），判定写入元数据 `Label`（`everyone` / `adult`）；`adult` 重定向 `/block-img`。
- **审核恰好一次**：`Label ≠ None` 的文件后续访问直接复用结论（实测首访 2.7s 含推理，复访 0.4s）。
- **Fail-open 例外**：模型对无法判定内容（如实测的 1×1 像素图）返回空判定时 `Label=None`，文件照常服务，且**每次访问都会重试审核**——上游设计权衡，部署此类异常文件才会发生。
- **删除语义**：后台「删除记录」仅移除 KV 元数据（列表/审核结论），文件字节保留在 Telegram 侧，知道完整 file_id URL 仍可取回。需彻底清除时到 Telegram 侧处理。
- 防盗链：`ALLOWED_REFERERS` 未设置（直链全放行）；如需开启参考 `functions/file/[id].js`。

## 6. 验收命令（2026-10-27 全部通过）

```bash
# 匿名访问受保护路径 → 应 302 到 cloudflareaccess.com
curl -sI https://t.rcrc.eu.org/ | grep -i '^HTTP\|^location'
curl -sI https://t.rcrc.eu.org/admin | grep -i '^HTTP'
curl -s -X POST -o /dev/null -w "%{http_code}\n" https://t.rcrc.eu.org/upload

# 直链免登 → 应 200 image/png（不存在的文件为 404）
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://t.rcrc.eu.org/file/<id>

# Service Token 上传（无 Cookie）
curl -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" \
     -F "file=@test.png;type=image/png" https://t.rcrc.eu.org/upload

# 配置自检（登录会话内）→ ready:true, problems:[]
curl -s https://t.rcrc.eu.org/api/config
```

应用自身健康检查 `/api/config` 返回 `ready:true`，`setup: storage=ok / moderation=cloudflare-ai / dashboard=ok`，`problems: []`。

## 7. 隐私说明

- 页面源码无任何第三方遥测（仓库 `test/privacy.test.js` 保证：无 Sentry/Hotjar/Clarity 等）。
- 后台 UI 库已全部自托管（`assets/vendor/`：Vue 2.6.14、Element UI 2.15.3、jQuery 3.6.4、Font Awesome 6.7.2），三个后台页面零第三方请求；所有引用保留/补齐了 SRI 完整性哈希。升级库版本时需重新下载并更新 SRI。
- 页面上存在 Cloudflare Web Analytics 埋点，来自 rcrc.eu.org zone 级「自动设置」（早于本部署，同时作用于监控站）；未关闭以避免影响其它业务。如需关闭：dash → Web Analytics → rcrc.eu.org → 管理站点。

## 8. 已知行为（上游设计）

- **网格视图跳转**：未配置 `BASIC_USER` 时，`admin-imgtc.html` 的 `check` 接口返回 "Not using basic auth."，页面 JS 误判为未登录并跳转登录流程（manage API 本身不需要 basic auth，数据接口不受影响）。主面板与瀑布流无此问题。
- **删除语义**：删除仅移除 KV 元数据，文件字节保留在 Telegram 侧，按完整 file_id URL 仍可取回（见第 5 节）。

## 8. 本轮部署变更记录

| 提交 | 内容 |
|---|---|
| `b5e572d` | 空提交：激活 `TG_Bot_Token` Secret（首次部署因缺 `TG_Chat_ID` 上传报 500） |
| `d9cf432` | 自托管后台 UI 库，移除 jsdelivr 依赖（补齐全部 SRI） |
| `2740dfb` | 修复：`TG_Chat_ID` 补入 `wrangler.toml [vars]` |

历史：`14fb777` 配置生产绑定；`95bcbc3` 私有化加固（隐私测试基线）。
