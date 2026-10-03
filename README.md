# aotulinuxdo

简体中文 · [English](README_EN.md)

面向 [Linux.do](https://linux.do/) 的本地 Google Chrome 阅读助手，由增强版用户脚本迁移而来。采用 Manifest V3（Chrome 扩展配置格式），无需油猴或编译。

## 功能

- 点击扩展图标，在新标签打开 Linux.do。
- 自动阅读、平滑滚动、停顿、阅读计时与历史记录。
- 可选自动点赞，支持点赞模式及最低点赞数配置。
- 使用页面 Pointer/Mouse 事件操作链接与按钮；不申请 `chrome.debugger`，不模拟硬件级可信鼠标事件。
- Lv2 及以上读取 Connect 账户条件，区分实际等级与目标等级。
- 紧凑账号面板：表情图标、细进度条、更新时间与昨日变化。昨日比较需要已保存的同等级、同统计范围记录。
- 刷新失败保留同一账号上次成功的数据；账号缓存隔离，等级接口遇到 429 时进入冷却。

## 环境与安装

需要支持 Manifest V3 的 Google Chrome，以及已登录的 Linux.do 账户。

1. 在本仓库点击 **Code → Download ZIP**，将压缩包解压到固定文件夹。
2. 在 Chrome 地址栏输入 `chrome://extensions/`。
3. 开启右上角 **开发者模式**，点击 **加载已解压的扩展程序**。
4. 选择包含 `manifest.json` 的文件夹，不是外层目录或 ZIP 文件。
5. 打开并刷新 [Linux.do](https://linux.do/)，看到助手面板即加载成功。

更新时替换本地源码，在扩展管理页点击 **重新加载**，再刷新论坛页面。无需 Node.js、API Key 或手动修改配置文件。

## 配置与使用

1. 在 **设置** 标签调整阅读速度、范围和数量等选项。
2. 在 **阅读** 标签设置点赞模式和最低点赞数；最低点赞数默认 `5`。自动点赞是可选功能，请按需启用。
3. 点击 **开始阅读**，面板显示阅读状态及计时；点击停止可结束当前阅读。
4. 在 **账号** 标签查看条件及更新时间，点击 **刷新** 手动更新。
5. 点击面板右上角的 GitHub 图标可打开本仓库。

### “近100日浏览”更新规则

该数字读取账户信息中“浏览帖子”的当前值：`18142/20000` 只取左侧 `18142`，不把升级门槛当成浏览数。

| 场景 | 更新数字 |
| --- | --- |
| 点击开始阅读 | 是 |
| 阅读结束或手动停止 | 是，短暂延迟后更新 |
| 点击“近100日浏览”数字 | 是 |
| 自动阅读跳转、页面重载、扩展重新注入 | 否，保留缓存 |

Lv0/Lv1 账户条件使用论坛累计统计；Lv2+ 使用 Connect 条件。只有页面明确标注近100日范围时，账号面板才将其标为近100日。

### Connect 后台标签

需要新数据时，扩展优先复用阅读窗口已有的 [Connect 账户页](https://connect.linux.do/)；没有则后台新建，不主动切换标签。读取成功后，仅自动关闭本次新建且仍处于后台的 Connect 标签。

已有标签、用户主动切入的标签或导航到其他网站的标签不会被关闭。登录、验证或读取失败时保留页面，方便处理。已有有效缓存时直接展示，自动阅读跳转不重新打开账户页。

## 常见问题

- **403、未登录或需要验证：** 切到保留的 Connect 标签，完成登录或验证，确认与论坛是同一账号，再返回助手点击刷新。扩展不会绕过验证。
- **429：** 等级接口已限流，请等冷却结束后重试，避免连续刷新。
- **昨日变化未显示：** 需要昨日已成功保存的可比记录；未获取的数据不会作为零处理。
- **界面没有更新：** 先重新加载扩展，再刷新论坛；已有 Connect 标签也需要刷新。
- **字段未获取：** 网站结构可能变化；请核对账户页并手动刷新，不要把旧缓存当作实时结果。

## 权限与目录

`storage` 用于保存设置和状态；网站权限仅涉及 `linux.do`、`idcflare.com` 与 `connect.linux.do`。Connect 快照通过扩展内部消息传递，不接入云同步、排行榜或额外账户服务。

```text
background/service-worker.js  后台请求与临时标签管理
content/assistant.js          界面、自动阅读与点赞逻辑
content/account-parser.js     共享账户字段解析
content/connect-reader.js     Connect 页面读取
content/bridge.js             用户脚本兼容层及页面操作
lib/html2canvas.min.js        本地截图依赖
linux.do.png                 扩展图标
manifest.json                扩展配置
```

## 2.6.6 更新

统一实时与缓存账号展示、修正等级判断、改善字段解析；增加紧凑表情界面与昨日对比；后台 Connect 临时标签读取成功后自动关闭。

修复自动点赞的首帖 ID 识别：支持首帖内部属性及反应计数器，区分楼层号与真实帖子 ID；等待字段就绪，且不以任意回复替代首帖，点击前再次确认页面与首帖。

首帖优先使用已核对的 `article#post_1[data-post-id]` 结构。已对用户提供的真实 HTML 完成离线解析回归测试；尚未完成浏览器内实际点赞验证。页面回应总数可能包含多个表情，不等同于单独的爱心数量。

账户解析思路参考 [LDStatusPro](https://github.com/caigg188/LDStatusPro)，在本扩展中独立实现。主脚本保留原项目的 MIT License 声明；`html2canvas` 遵循自身许可证。

自动化访问可能受网站规则、限流或页面变化影响。请合理设置速度与数量，并遵守网站服务条款及社区规则。

## English

Local Chrome extension for automatic Linux.do reading, optional likes and account statistics. Load the folder containing `manifest.json` through `chrome://extensions/` → **Developer mode** → **Load unpacked**. No build step is required. See the corresponding [English guide](README_EN.md) for configuration, refresh rules and troubleshooting.
