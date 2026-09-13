import { SHELL } from '../src/ui.mjs';
import styles from '../src/workspace.css';
import katexStyles from 'katex/dist/katex.min.css';
import { answerHTML } from '../src/render.mjs';
const sample = `## 一句话抓重点
**相关性不能独自说明因果关系。** 本段通过混杂因素说明：观察到两个变量一起变化，不等于改变其中一个就能改变另一个。
## 中文翻译
观察数据中的关联可能由共同原因造成。因此，识别干预的效应需要额外的假设，而不能只依赖统计关联。
## 推理与全文作用
1. 提出观察关联的局限。
2. 用共同原因解释为什么关联可能误导。
3. 引出后文关于干预与识别假设的方法。
这是教学示例，不代表某篇真实论文的结论。
## 必要术语
- **Confounding / 混杂**：共同原因同时影响两个变量，干扰因果判断。
- **Intervention / 干预**：主动改变变量，而非仅观察它。
## 证据与边界
这里只解释示例选段。尚无真实全文或图表，不能据此判断具体方法是否有效。
## 公式排版示例
$$
\\hat{\\beta}=(X^\\top X)^{-1}X^\\top y, \\qquad \\sum_{i=1}^{n} w_i=1
$$
其中 \\(\\hat{\\beta}\\) 是带上下标、转置和求和上下限的示例。`;
const previewMathStyles = katexStyles
  .replace(/,url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g, '');
export const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Next 精读工作台 · 静态设计预览</title><style>${styles}\n${previewMathStyles}</style><body>${SHELL}<script>
document.getElementById('paper-title').textContent='因果推断入门 · 教学示例';
document.getElementById('sessions').innerHTML='<button class="session">全文导读与问答<span class="small">1 条回答</span></button><button class="session active">Why association is not causation<span class="small">3 条回答 · 已锁定原文</span></button>';
document.getElementById('thread-picker').innerHTML='<option>关联与因果：选段精读</option>';
document.getElementById('source-text').textContent='Association in observational data may arise from common causes. Identifying intervention effects therefore requires additional assumptions.';
document.getElementById('messages').innerHTML=${JSON.stringify(`<article class="message"><div class="message-meta">你 · 10:24</div><div class="question">这段在讲什么？在全文中起什么作用？</div></article><article class="message"><div class="message-meta">精读助手 · 10:24 · ★ 已收藏</div><div class="answer">${answerHTML(sample)}<div class="message-actions"><button>引用追问</button><button>★ 已收藏</button><button>复制回答</button></div></div></article><article class="message"><div class="message-meta">你 · 10:25</div><div class="question">能用一个生活例子解释“共同原因”吗？</div></article><article class="message"><div class="message-meta">精读助手 · 10:25</div><div class="answer">${answerHTML('## 直接回答\n教学例子：夏天冰淇淋销量和游泳人数一起上升，**气温**可能是共同原因。不能因此推出买冰淇淋会让人去游泳。\n## 为什么\n气温分别影响购买行为和游泳行为。这个例子只说明混杂机制，并不证明某个具体数据集里有因果关系。')}</div></article>`)};
document.getElementById('status').textContent='静态设计预览 · 示例非真实模型输出 · 不连接 API';
document.getElementById('focus').onclick=()=>document.body.classList.toggle('focus-mode');
document.getElementById('font').onclick=()=>document.getElementById('messages').classList.toggle('read-size');
document.querySelectorAll('button').forEach(b=>{if(!['focus','font'].includes(b.id))b.disabled=true});
</script></body></html>`;
