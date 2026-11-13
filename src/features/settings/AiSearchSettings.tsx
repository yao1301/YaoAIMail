/** Ordinary users should never need to deploy or tune a search service. */
export default function AiSearchSettings() {
  return <section aria-label="自动联网搜索" style={{
    padding: 14, marginBottom: 18, borderRadius: 8,
    border: "1px solid var(--color-border)", background: "var(--color-bg-primary)",
  }}>
    <h3 style={{margin: "0 0 8px", fontSize: 14}}>自动联网搜索</h3>
    <p style={{margin: 0, fontSize: 13, lineHeight: 1.7, color: "var(--color-text-secondary)"}}>
      在首页、开发客户或公司调研中直接提出问题即可，无需配置本地搜索服务。
      搜索来源切换、去重、缓存和请求保护由软件自动处理。
    </p>
  </section>;
}
