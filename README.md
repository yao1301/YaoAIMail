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
- 多语言自动判断：回复沿用来信正文的语言（忽略旧引用、签名和界面语言）；新邮件按你选的默认语言或业务语境判断，没依据时用英文；不擅自编造。
- **直写草稿**：结果直接进草稿编辑区，不用再来回复制；每次生成前自动留快照，可以一版版撤销，也能重做（保留最近 8 版）。**AI 碰不到发送按钮**，所有内容先停在草稿箱。
- 指令框可拖入邮件、附件、文件、图片和资料中心的资料。

### 2. 写作风格系统 —— 让 AI 写得像你本人
- **从你的已发送邮件学习**真实风格：句子长短、段落节奏、称呼、开场、结尾、直接程度。
- **自动脱敏**：学习前清掉引用、签名、联系方式、价格、订单号，不把旧客户旧价格带出来。
- 给欧美客户一套正式的、给老客户一套随意的，按账号分配。
- 硬边界：AI 只能用风格改表达方式，不能从历史里带出旧承诺。

### 3. 首页 AI 工作台 —— 对着自己的邮箱提问
- 一个 AI 指令框为核心，自动判断这次是要聊天、读邮件、查资料、联网调研还是直接起草。
- 内置 7 个外贸分析方法，可直接点名或自动匹配：客户背景调研、公司邮箱核验、研究后写开发信、外贸回复策略、客户跟进规划、每日外贸简报、往来邮件总结。
- 邮件总结调用的是全邮箱检索：收件箱、已发送、归档都能读到，只排除垃圾箱和废纸篓。
- 对话自动生成标题并按账号保存历史，可随时切回；引用可点击直达原文。
- 涉及动手的操作（起草、定时发送、整理邮件）先出预览卡，你确认才执行，AI 不会自己发信。

### 4. 产品与资料中心 —— 把报价参数喂给 AI
- 导入 PDF、Word、Excel、CSV、TXT、Markdown、JSON、HTML、XML；PDF 保留页码、Excel 保留工作表定位。
- 本地混合检索 + 自然语言问答，直接问“X 产品的付款方式是什么”。
- **有依据才回答**：引用资料名称和位置；资料库里没有就明说没找到，不猜价格不承诺。

### 5. 地址本与客户管理 —— 客户资料归到一处
- 联系人角色标签（客户、工厂、供应商、物流/服务商等）、公司级客户画像、客户分层（重点／常规／培育）。
- 客户管理有列表和看板两种视图，按阶段（待开发→已联系→已报价→已寄样→谈判中→已成交）分列。
- 邮件往来 + 人工跟进记录统一显示；电话、WhatsApp、微信、展会、样品都能记。
- “下一步建议”按客户阶段给一句具体动作，本地规则生成、不调模型、不花额度；多步跟进计划可自动准备草稿；想知道“这周该跟进谁”，用工作台的客户跟进规划。

### 6. AI 开发客户 —— 找客户、找邮箱、写开发信
- 用自然语言描述产品、市场、客户类型，模型驱动**多渠道公开网络研究**：官网、公司页、当地语言、目录、协会、展会、地图。
- 邮箱证据分五档标明来路：官网页公布、验证服务报告、按域名规则推测、纯猜测、未找到；再叠加一层可投递性结果（验证通过／无效／全收域／受阻／一次性邮箱／未检查）。域名对不上公司身份的直接丢弃。
- 开发信按“短（50–100 词）、三四个核心句、只给一个低门槛钩子”的写法生成，不群发。
- 搜索引用的资料会**继承到开发信**，不会跑偏；支持生成前预览、AI 调整改写、自动开发队列（多家公司排队处理，切走页面任务也不中断）。

### 7. 资信调研 —— 买家的底，先摸一遍
- 输入公司名、域名或联系人即可发起，综合官网、公开企业信息、行业、新闻、展会等来源。
- 额外接入两项硬核核验：**GLEIF 全球法人数据库**核对法人主体与注册信息，**OFAC 制裁名单**做名称初筛（只覆盖当前名单及别名的精确初筛，不等于合规放行）。
- 输出：一句话结论、公司概况、实力与资质、采购与供应链线索、风险信号、建议核实事项、合作建议、信息来源清单。
- **诚实标注**：查过的材料标来源和时效；查不到、核不实的明确标“待核实”，不装作知道。

### 8. 发送防呆 —— 防止把成本单发给客户
- 收件人自动分成五类：客户、供应商、服务商（货代／报关／验货／银行等）、内部同事（自己域名）、未分类。只要收件人里有客户或供应商就会检查，全是服务商和内部地址则直接放行。
- 判冲突时先跑本地规则（关键词、草稿意图）；如果你配了模型，会再用 AI 复核一遍“这封信会不会发错对象”。没配模型或调用失败，自动回落到本地规则，不会因此卡住发送。
- 服务商一律跳过，给货代发订舱邮件不会误报。
- **默认关闭**，需要在设置 → 发送防呆里手动打开；有“提醒”和“拦截”两档，拦截时点“仍然发送”可以强行放行。
- 配套的保险：发出后有**撤回窗口**，默认 5 秒（可调 0／5／10／15／30 秒）；也可以设定时发送，到点再走。

### 9. 外贸工具箱 + 文字翻译
- **世界节假日**（中国、英国、美国）、**参考汇率**（人民币基准，可自选多币种换算）、**多时区**、**装柜数量快速估算**。
- **HS 编码辅助查询**和**物流／集装箱／空运追踪**是查询入口：一键打开 HS编码网、WCO、中国海关、马士基、达飞、DHL 等官方页面。软件本身不算税、不生成轨迹——打开入口不等于查到了结果。
- 选中文字即翻译，浮窗显示，默认中文，可改默认目标语言；也可整封邮件双语对照。

---

## 特色（Why YaoAIMail）

- **AI 懂上下文**：看到的是线程 + 客户档案 + 往来记录 + 资料库，不是复制粘贴的一段字。
- **写得像本人**：从已发送邮件学风格，学之前自动脱敏。
- **AI 只碰草稿**：发送权永远在你手里，不替你猜价格和承诺。
- **查不到就说查不到**：每条结果标来源，核不实的标“待核实”，不编造。
- **数据在自己电脑上**：本地优先，没有云端账号体系，AI 只收当前任务需要的内容。
- **外贸全流程闭环**：从收件、理解、写作、跟进，到开发客户、资信调研、客户沉淀，原生串起来。
- **发送防呆**：把发错对象的事故防在发送前，通用邮件客户端不做这件事。
- **中文界面 + 模型自由 + 国内可用**：可选 DeepSeek / OpenAI / Gemini 或任意兼容接口，支持 SOCKS5 代理，钥匙在自己手里。

---

## 数据与隐私（Privacy）

- 邮件、附件、客户记录、资料库、风格档案和搜索索引优先保存在本地。
- AI 写作默认只发送当前邮件上下文、用户指令、主动选择的资料和少量脱敏风格样本；不会因为用一次 AI 就把整个邮箱传上去。
- 生成邮件始终先进草稿，用户确认后才发送。
- 需要备份设置时，可以接**你自己的 WebDAV**（如坚果云）；备份文件用你设的口令加密，不经过任何厂商服务器——这个软件没有云端账号体系。
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
|   |-- pebble-privacy/     HTML 清洗与追踪控制
|   |-- pebble-research/    调研任务引擎（客户线索／公司／联系人）
|   `-- pebble-websearch/   公开网络检索、公司画像与邮箱核验（不发信、不碰邮箱）
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
- **发送防呆默认关闭**，要先在设置里打开；而且它防不了所有错——防不了“该发客户 A 却发给了客户 B”，效果也依赖联系人角色标得准。
- **外贸工具箱是查询入口和估算器，不是海关数据库**：HS 编码和物流追踪只是帮你打开官方查询页，节假日和汇率来自公开接口（可能滞后），装柜只是几何估算。报关级别的决策必须人工核实。
- **资信调研不是信用报告**：组合公开来源做参考，GLEIF 和 OFAC 初筛都不构成法律、财务或信用担保。
- **开发客户的邮箱有边界**：每条邮箱都标了来源档位和可投递性结果，但公开网页数据可能过期，LinkedIn 只用公开索引。
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
