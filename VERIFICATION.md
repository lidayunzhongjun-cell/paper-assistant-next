# 验证记录（2.0.1）

## 安装失败原因与修复

- 本机 Zotero 版本：9.0.6。
- 只读检查 `C:/Program Files/Zotero/omni.ja` 中 `modules/Extension.sys.mjs`，其第 1873—1875 行对缺失 `applications.zotero.update_url` 的扩展调用 `manifestError`。
- 2.0.0 安装包确实缺少该字段。2.0.1 补齐更新地址，插件 ID 与 `9.0`—`9.*` 兼容范围不变。
- `npm run check:zotero` 提取并执行上述**本机真实校验片段**，对照实际 XPI 清单：2.0.0 返回 `applications.zotero.update_url not provided`；2.0.1 无错误。
- 该检查只覆盖 Zotero 专用清单校验片段，不包括完整扩展 schema、安装器、加载与 UI 验收。没有更改用户 Zotero 配置、启停插件或调用 API。
- 更新地址为原项目 GitHub Releases 中独立的 `update-next.json` 附件路径；尚未发布在线更新文件，本次通过手动 XPI 安装分发。

## 已完成

- `npm test`：17/17 通过。原有 13 项覆盖历史问答入参、引用、长历史的成对裁剪、字符分块完整性、材料不足标记、HTML 转义、表格空单元格、Markdown 导出、API 错误与截断、取消请求、持久化与文件损坏处理。新增 4 项覆盖版本一致性、Zotero 必填字段（含 update_url 回归）、更新地址格式、独立 ID 与最低版本约束。
- `npm run build`：生成 `dist/paper-assistant-next-2.0.1.xpi`，清单必填字段、ZIP 完整性与正斜杠资源路径检查通过。
- `npm run check:zotero`：真实宿主校验片段对照测试通过；旧错误可复现，新清单通过。
- `npm audit`：0 个已知漏洞；发布更新清单的下载地址与 XPI SHA-512 校验一致。
- 安装包内 bootstrap 在模拟 Zotero 宿主执行成功：菜单 1 个，Reader 事件 2 个，ID 与清单一致；shutdown 清理菜单。
- 使用本机 Zotero 的 `plugins.js` 核对 bootstrap 可用的 Zotero、Services、IOUtils、PathUtils、URL 全局，并在独立脚本作用域显式传入。
- 旧版 `git status --porcelain` 为空；旧版安装包已另存，未重新生成或覆盖旧版。

## 未完成的验收

- 没有真实 Zotero 安装、启用、选段或重启交互验收；宿主模拟测试不代替这些检查。
- 没有调用用户 API，没有测试真实模型质量与服务费用。
- 内置浏览器拒绝访问本地预览 HTML，未进行自动视觉验收。可手动打开 `dist/reading-workspace-preview.html` 查看示例。

## 安装后的 5 分钟检查

1. 从插件管理器安装 `paper-assistant-next-2.0.1.xpi`，确认列表显示 **Paper Assistant Next · 精读工作台 2.0.1**。请勿继续使用 2.0.0 包。
2. 打开 PDF，选中一段原文，点击 **精读 / 连续追问**。检查左侧论文标题、锁定原文均正确。
3. 保存 API 设置，发送“这段在讲什么？”；收到回答后再问“请用例子解释”。应保留两个问答回合。
4. 选中第一条回答中的一句话，点击它下方“引用追问”，输入更具体的问题；发送前应显示引用内容。
5. 切到另一篇 PDF 再回到原工作台，检查原会话论文标题没有变化。
6. 收藏一条回答、标记读懂，关闭工作台，再从原 PDF 打开，确认记录、收藏与标记仍在。
7. 可选：在“建立全文导读”的发送确认框查看服务域名和字符量，再决定是否提交。

若安装失败，请打开 **工具 → 开发者 → Error Console**，重现一次，记录第一条与该插件 ID、`applications.zotero`、`XPIInstall`、`Extension.sys.mjs` 或 `bootstrap.js` 相关的错误。安装阶段可能尚未执行 bootstrap，因此不要只筛选插件名称。不要把所有文献调试日志或 API Key 一并复制。
