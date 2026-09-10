# 更新记录

## 2.0.1 — 2026-09-10

- 首个独立公开版本。
- 新增按论文固定的全文导读与选段精读工作台。
- 支持保留历史的多轮追问、引用回答继续追问、会话持久化与 Markdown 导出。
- 支持中文翻译、通俗解释、全文作用分析和关键术语说明。
- 修复 2.0.0 清单缺少 `applications.zotero.update_url` 导致 Zotero 9.0.6 拒绝安装的问题。
- 新增 Zotero 清单回归校验、17 项自动测试及打包后启动冒烟测试。

## 与旧项目的关系

本项目使用 `paper-assistant-next@astralscarsmoonshadow` 作为独立插件 ID，不替换或迁移 `zotero-paper-mind`，也不覆盖其配置和阅读缓存。
