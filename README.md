<p align="center">
  <img src="public/yao-logo.png" alt="YaoAIMail logo" width="120">
</p>

<h1 align="center">YaoAIMail（老妖 AI 外贸邮）</h1>

<p align="center">
  一个内置懂外贸 AI 的 Windows 邮件客户端：收发邮件、AI 写信、客户管理、开发客户、资信调研，一个软件干完。
</p>

<p align="center">
  <em>An AI-powered Windows email client built for B2B cross-border sellers — reply, manage customers, find leads and vet buyers in one place.</em>
</p>

<p align="center">
  <a href="https://github.com/yao1301/YaoAIMail/releases">Releases</a>
  ·
  <a href="LICENSE">License</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/models-OpenAI%20%7C%20DeepSeek%20%7C%20Gemini%20%7C%20custom-orange?style=flat-square" alt="Models">
</p>

---

## 它解决什么问题（Problem）

外贸业务员每天要回不同国家客户的邮件。过去的工作流是这样：

> Foxmail/Outlook 看客户邮件 → 打开网页 AI → 复制过去 → 输入要求 → 生成 → 复制回来 → 手工检查 → 发送

这条链有四个绕不过去的坑：

1. **网页 AI 不懂这个客户** — 不知道你们聊到哪一步、上封确认过什么、起订量多少、定金怎么谈。
2. **写出来不像你** — 标准商务英语，客户聊了大半年一眼看出换人了。
3. **它敢编** — 价格、交期、承诺都敢替你编，外贸这行编错一个价格赔一单。
4. **来回切换太累** — 一天几十封邮件，全是复制粘贴的体力活。

**YaoAIMail 让 AI 直接住在邮箱里**：打开客户邮件的那一刻，它就知道这是谁、聊到哪、该用什么语气回。

> *Four problems with the copy-paste workflow: the web AI doesn't know the customer, it doesn't write like you, it fabricates facts, and the switching is exhausting. YaoAIMail puts an AI that knows your business directly inside your inbox.*

---

## 核心功能（Features）

### 1. AI 写邮件与回复 —— 读全上下文，不是复制粘贴
- AI 读的是**当前邮件、整个线程和这个客户的往来记录**，不是手动复制的一小段。
- 多轮对话：生成第一版后继续提要求，改到满意为止。
- 多语言自动判断，新联系人跟随你的选择语言，不擅自编造。
- **直写草稿**：结果直接进草稿编辑区，支持撤销对比；**AI 碰不到发送按钮**，所有内容先停在草稿箱。
- 指令框可拖入邮件、附件、文件、图片和资料中心的资料。

### 2. 写作风格系统 —— 让 AI 写得像你本人
- **从你的已发送邮件学习**真实风格：句子长短、段落节奏、称呼、开场、结尾、直接程度。
- **自动脱敏**：学习前清掉引用、签名、联系方式、价格、订单号，不把旧客户旧价格带出来。
- 给欧美客户一套正式的、给老客户一套随意的，按账号分配。
- 硬边界：AI 只能用风格改表达方式，不能从历史里带出旧承诺。

### 3. 首页 AI 工作台 —— 对着自己的邮箱提问
- 一个 AI 指令框为核心：总结邮件、查资料、回答问题、写邮件、开发客户、资信调研，自动识别意图。
- 邮件总结综合读收件箱、已发送和其他文件夹，不是只看收件箱。
- 对话自动生成摘要标题并保存历史，可搜索回看；引用可点击直达原文。

### 4. 产品与资料中心 —— 把报价参数喂给 AI
- 导入 PDF、Word、Excel、CSV、TXT、Markdown、JSON、HTML、XML；PDF 保留页码、Excel 保留工作表定位。
- 本地混合检索 + 自然语言问答，直接问"X 产品的付款方式是什么"。
- **有依据才回答**：引用资料名称和位置；资料库里没有就明说没找到，不猜价格不承诺。

### 5. 地址本与客户管理 —— 客户资料归到一处
- 联系人角色标签（客户、工厂、供应商、服务商等）、公司级客户画像、客户分层。
- 邮件往来 + 人工跟进记录统一显示；电话、WhatsApp、微信、展会、样品都能记。
- AI 下一步建议："这周该跟进谁"。

### 6. AI 开发客户 —— 找客户、找邮箱、写开发信
- 用自然语言描述产品、市场、客户类型，模型驱动**多渠道公开网络研究**：官网、公司页、当地语言、目录、协会、展会、地图。
- 结果严格区分**已验证 / 待验证 / 格式推测 / 公共邮箱 / 未找到**；域名对不上公司身份的直接丢弃。
- 开发信按"短（50–100 词）、三四个核心句、只给一个低门槛钩子"的写法生成，不群发。
- 搜索引用的资料会**继承到开发信**，不会跑偏；支持预览、AI 调整、多邮箱队列。

### 7. 资信调研 —— 买家的底，先摸一遍
- 输入公司名、域名或联系人即可发起，综合官网、公开企业信息、行业、新闻、展会等来源。
- 输出概况、主营、客户匹配、规模线索、风险、机会、联系人、建议动作。
- **诚实标注**：每条标来源和时效；查不到、核不实的明确标"待核实"，不装作知道。

### 8. 发送防呆 —— 防止把成本单发给客户
- 客户/供应商/服务商五层自动分类，冲突组合发送前拦截："仍然发送"才放行。
- 零延迟，发信路径不调 AI，不额外等待。
- 服务商标识别：给货代发订舱邮件不会误报。

### 9. 外贸工具箱 + 文字翻译
- HS 编码、税费估算、物流轨迹、汇率（人民币基准）、多时区、装柜计算。
- 选中文字即翻译，浮窗显示，默认中文，可调目标语言。

---

## 特色（Why YaoAIMail）

- **AI 懂上下文**：看到的是线程 + 客户档案 + 往来记录 + 资料库，不是复制粘贴的一段字。
- **写得像本人**：从已发送邮件学风格，学之前自动脱敏。
- **AI 只碰草稿**：发送权永远在你手里，不替你猜价格和承诺。
- **查不到就说查不到**：每条结果标来源，核不实的标"待核实"，不编造。
- **数据在自己电脑上**：本地优先，没有云端账号体系，AI 只收当前任务需要的内容。
- **外贸全流程闭环**：从收件、理解、写作、跟进，到开发客户、资信调研、客户沉淀，原生串起来。
- **发送防呆**：把发错对象的事故防在发送前，通用邮件客户端和 AI 工具都没有。
- **中文界面 + 模型自由 + 国内可用**：可选 DeepSeek / OpenAI / Gemini 或任意兼容接口，支持 SOCKS5 代理，钥匙在自己手里。

---

## 数据与隐私（Privacy）

- 邮件、附件、客户记录、资料库、风格档案和搜索索引优先保存在本地。
- AI 写作默认只发送当前邮件上下文、用户指令、主动选择的资料和少量脱敏风格样本；不会因为用一次 AI 就把整个邮箱传上去。
- 生成邮件始终先进草稿，用户确认后才发送。
- 分享包本身不带任何账号信息、邮箱数据、数据库、日志和个人路径。

---

## 快速开始（Getting Started）

### 安装
Windows 10/11 桌面软件，提供安装版和绿色版。从 [Releases](https://github.com/yao1301/YaoAIMail/releases) 下载。

### 使用顺序（三步就能用起来）
1. **加邮箱**：支持 IMAP / POP3，Gmail、Outlook 有对应的登录或授权方式。
2. **配模型**：内置 OpenAI、DeepSeek、Gemini 预设，选好服务商只填一个 API Key；也支持自定义接口和 SOCKS5 代理。
3. **试 AI 写作**：导入产品资料，在真实邮件上试用。

> AI 功能需要你自己配置模型 API Key（费用按用量付给模型服务商）；基础邮件收发可以零配置使用。

### 从源码开发（Development）

```bash
git clone https://github.com/yao1301/YaoAIMail.git
cd YaoAIMail

pnpm install
cp .env.example .env

pnpm dev
```

前端检查与后端检查：

```bash
npx tsc --noEmit   # 前端类型检查
cargo check        # 后端编译检查
```

> 注意：本项目在 Windows 上使用 GNU toolchain + MinGW 构建，静态链接配置见 `.cargo/config.toml`。

---

## 技术栈（Tech Stack）

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2 |
| 后端 | Rust |
| 前端 | React 19, TypeScript |
| 状态 | Zustand, TanStack Query |
| 数据库 | SQLite (rusqlite) |
| 搜索 | Tantivy |
| 本地化 | i18next（中英） |

---

## 项目结构（Project Structure）

```text
YaoAIMail/
|-- src/                    React 前端
|   |-- components/         通用 UI 组件
|   |-- features/           收件箱、写信、搜索、客户画像、开发客户、资信调研、设置
|   |-- hooks/              React hooks 和查询助手
|   |-- lib/                IPC API、i18n、工具
|   `-- stores/             Zustand store
|-- src-tauri/              Tauri 应用与 IPC 命令
|-- crates/                 Rust 工作区 crates
|   |-- pebble-core/        共享类型与错误
|   |-- pebble-store/       SQLite 持久化
|   |-- pebble-mail/        邮件提供方与同步
|   |-- pebble-search/      Tantivy 搜索索引
|   |-- pebble-crypto/      凭据加密
|   |-- pebble-oauth/       OAuth 2.0 与 PKCE
|   |-- pebble-rules/       规则引擎
|   |-- pebble-translate/   翻译提供方
|   `-- pebble-privacy/     HTML 清洗与追踪控制
|-- tests/                  前端测试
`-- public/                 logo 等静态资源
```

---

## 关于本 Fork（About this fork）

**YaoAIMail（老妖 AI 外贸邮）** 是基于开源邮件客户端 [QingJ01/Pebble](https://github.com/QingJ01/Pebble) 二次开发的增强版，专为 B2B 跨境外贸卖家打造。

在上游 Pebble（稳定的邮件客户端地基：多账户、IMAP/POP3、全文搜索、标签页、规则引擎、本地优先）之上，本 fork 增加了上文列出的完整外贸 AI 能力：AI 写作、风格学习、客户画像、开发客户、资信调研、发送防呆和外贸工具箱。

本项目及其所有修改均遵循 **AGPL-3.0** 协议发布，原作者的版权声明和许可证原文保持不变。

---

## 诚实边界（Honest limitations）

- **AI 生成的内容必须人工检查**，尤其是价格、交期、订单号、付款条件和承诺。软件防的是流程错误，不替你做业务决定。
- **发送防呆防不了所有错**：防不了"该发客户 A 却发给了客户 B"，也依赖联系人角色标得准。
- **外贸工具箱是 AI 参谋，不是海关数据库**：HS 编码、税费、物流结果是参考性质，报关级别决策必须人工核实。
- **资信调研不是信用报告**：组合公开来源做参考，不等同于法律、财务或信用担保。
- **开发客户的邮箱有边界**：分已验证和推测，公开网页数据可能过期，LinkedIn 只用公开索引。
- **系统要求**：Windows 10/11 最稳，依赖 WebView2；Windows 7 不保证；目前无 Mac 版。
- **需要自己配模型**：有自己的 API Key 是使用 AI 功能的前提，费用按用量付给服务商。

---

## License

本项目基于 [AGPL-3.0](LICENSE) 协议发布。

*Based on [QingJ01/Pebble](https://github.com/QingJ01/Pebble), licensed under AGPL-3.0. The original author's copyright notice is preserved unchanged.*

---

<p align="center">
  由 <a href="https://github.com/yao1301">yao1301</a>（老妖）维护 · 一个十几年 B2B 外贸从业者做给自己、也做给同行用的工具。
</p>
