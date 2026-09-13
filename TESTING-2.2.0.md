# Paper Assistant Next 2.2.0 测试清单

## 自动验证

在项目目录运行：

```powershell
npm test
npm run build
npm run check:zotero -- --local
```

预期：45 项测试全部通过；生成 `dist/paper-assistant-next-2.2.0.xpi`；打包启动冒烟与本机 Zotero 清单兼容检查通过。

## Zotero 手工验收

1. 通过“工具 → 插件 → 齿轮 → Install Plugin From File…”安装 2.2.0 XPI。
2. 打开有 PDF 附件的论文，进入 Paper Assistant Next 工作台。
3. 点击“复制精炼提示语”，粘贴到 ChatGPT，连同论文生成 DOCX 或 UTF-8 TXT。
4. 点击“导入 AI 精炼稿”，选择文件。取消“立即建图”时，状态应显示“已本地导入、尚未发送”。
5. 点击“从精炼稿建立图谱”，确认 API 主机和字符量，再等待完成。
6. 图谱标题、边界说明、摘录和复制的 Markdown 都应明确显示“AI 精炼稿/二手材料/非论文原文”。
7. 若已存在 PDF 图谱，顶部“图谱来源”应同时出现“PDF 原文图谱”和“AI 精炼稿图谱”，来回切换不丢内容。
8. 从精炼稿图谱进入一个段落追问，回答材料说明应包含“AI 精炼稿图谱”和 PDF 原文检索状态。
9. 移除精炼稿，确认 PDF 图谱、PDF 和历史问答仍保留。

## 格式边界

- `.docx`、UTF-8 `.txt`、`.md` 可导入。
- `.doc` 应提示另存为 `.docx`；PDF、非 UTF-8 文本、损坏/加密 DOCX、少于 200 字符或超过 300,000 字符的内容应被拒绝。
- 导入阶段不调用 API；只有用户确认“从精炼稿建立图谱”后才发送。
