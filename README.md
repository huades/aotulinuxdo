# aotulinuxdo

[English](README_EN.md) | 简体中文

`aotulinuxdo` 是一个面向 [linux.do](https://linux.do/) 的本地 Google Chrome 扩展，由“linux.do 小助手（增强版）”迁移而来。它提供自动阅读、平滑滚动、阅读状态统计、账号信息展示及可选的自动点赞等功能。

## 主要功能

- 以 Chrome Manifest V3 扩展形式本地运行，无需油猴。
- 自动获取帖子并以平滑、带停顿的滚动轨迹阅读。
- 使用 Pointer/Mouse 事件序列操作页面中的帖子链接、点赞按钮和弹窗按钮。
- 保存今日阅读数、本次阅读状态和已读帖子历史。
- 阅读面板中的“近100日浏览”取自账号信息卡片“浏览帖子”一行：例如 `18142/20000` 显示 `18142`。
- 浏览帖子数只在点击“开始阅读”、阅读结束/手动停止或点击该数字时更新。
- 自动阅读期间的帖子跳转、页面重新加载及扩展重新注入不会刷新浏览帖子数。
- `html2canvas` 已包含在扩展内，不依赖远程运行时代码。

## 安装

1. 下载或克隆本仓库。
2. 在 Chrome 地址栏打开 `chrome://extensions/`。
3. 开启右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本仓库根目录。
6. 打开或刷新 `https://linux.do/`。

更新本地文件后，请在 `chrome://extensions/` 中点击扩展的“重新加载”按钮，再刷新 linux.do 页面。

## 浏览帖子数更新规则

| 场景 | 是否更新 |
| --- | --- |
| 点击“开始阅读” | 是 |
| 阅读完成或手动停止 | 是，短暂延迟后更新 |
| 点击“近100日浏览”数字 | 是 |
| 自动跳转到下一篇帖子 | 否 |
| 阅读页面重新加载 | 否 |
| 扩展重新注入或标签页恢复 | 否，只读取缓存 |

账号信息中的值采用 `current/required` 格式，本扩展只读取左侧 `current`，不会把右侧升级要求当作浏览数。

## 权限说明

- `storage`：保存扩展状态和设置。
- `linux.do`、`idcflare.com`：运行内容脚本。
- `connect.linux.do`：读取账号等级信息。

扩展未申请 `chrome.debugger` 权限。内容脚本生成的 Pointer/Mouse 事件不属于硬件级可信事件。

## 项目结构

```text
background/              后台 Service Worker
content/assistant.js     主要界面和自动阅读逻辑
content/bridge.js        油猴 API 兼容层与页面操作封装
lib/html2canvas.min.js   本地截图依赖
linux.do.png             扩展图标
manifest.json            Chrome Manifest V3 配置
```

## 使用提示

自动化访问可能受到网站规则、限流策略或页面结构变化影响。请合理设置阅读速度和数量，并遵守网站服务条款及社区规则。

## 许可证

主脚本沿用原项目标注的 MIT License。第三方库 `html2canvas` 遵循其自身许可证。
