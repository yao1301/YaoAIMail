//! Industry-neutral discovery plans and evidence grading. Scores are rule-based,
//! not probabilities; search snippets and model suggestions are never site proof.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Coarse discovery fallback only, not a verified product or buyer match.
/// All relevance vocabulary comes from this task rather than a fixed industry.
pub fn fallback_relevance(page_text: &str, product: &str, buyer_type: &str) -> bool {
    let stop_words = [
        "exclude", "buyer", "buyers", "company", "companies", "industry", "member",
        "directory", "trade", "show", "data", "about", "supplier", "market",
    ];
    let terms = |input: &str| input
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|word| word.len() >= 4 && !stop_words.contains(&word.as_str()))
        .collect::<Vec<_>>();
    let product_terms = terms(product);
    let buyer_terms = terms(buyer_type);
    let text = page_text.to_lowercase();
    product_terms.is_empty()
        || product_terms.iter().chain(buyer_terms.iter()).any(|term| text.contains(term))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LeadRequest {
    pub session_id:String,
    pub scope_id:String,
    pub page_size:usize,
    pub use_cases:Vec<String>,
    pub product_positioning:String,
    pub product: String,
    pub market: String,
    pub buyer_type: String,
    pub aliases: Vec<String>,
    pub channels: Vec<String>,
    pub local_queries: Vec<LocalQuery>,
    pub qualifiers: Vec<String>,
    pub exclusions: Vec<String>,
    pub requirements: String,
    pub exclude_websites: Vec<String>,
    pub page: usize,
    pub batch_mode: bool,
    /// Created by the native instruction planner, never trusted from IPC input.
    #[serde(skip)] pub task_plan: super::lead_research::TaskPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPlan { pub channel: String, pub query: String }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all="camelCase")]
pub struct LocalQuery {pub language:String,pub query:String}

fn compact(value: &str, limit: usize) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(limit).collect()
}

impl LeadRequest {
    pub fn bounded(mut self) -> Self {
        self.product = compact(&self.product, 180);
        self.market = compact(&self.market, 80);
        self.buyer_type = compact(&self.buyer_type, 80);
        self.product_positioning=compact(&self.product_positioning,1200);
        self.requirements = compact(&self.requirements, 6000);
        for values in [&mut self.aliases, &mut self.channels, &mut self.qualifiers, &mut self.exclusions,&mut self.use_cases] {
            *values = values.iter().map(|s| compact(s, 100)).filter(|s| !s.is_empty()).take(8).collect();
        }
        self.exclude_websites.truncate(100);
        self.local_queries.truncate(3);
        self.page = self.page.clamp(1, 100);
        self.page_size = if self.page_size==0 {20} else {self.page_size.clamp(1,20)};
        self
    }

    pub fn queries(&self) -> Vec<QueryPlan> {
        let variants=product_variants(&self.product);
        // Model summaries sometimes contain three product alternatives in one
        // parenthesis. Search them individually, not as an impossible AND query.
        let primary = if variants.len()>1 {variants[0].as_str()} else if self.product.contains(" / ") && self.product.contains('(') { self.product.split('(').next().unwrap_or(&self.product).trim() } else { &self.product };
        let p = primary;
        let market = market_keyword(&self.market);
        let m = &market;
        // Several valid roles belong in separate channel queries, not a long
        // accidental AND query. Keep the full role for semantic review.
        let primary_role=self.buyer_type.split(['/', '|', ',', ';']).map(str::trim).find(|s|!s.is_empty()).unwrap_or("");
        let role = match primary_role {"进口商"=>"importer","批发商"=>"wholesaler","经销商"|"分销商"=>"distributor","零售商"|"零售店"=>"retailer",v=>v};
        let channels: Vec<_> = self.channels.iter().filter(|c| super::lead_research::buyer_channel_term(c)).take(4).collect();
        let mut locals=vec![];
        for local in &self.local_queries {
            if super::lead_research::valid_local_query(&self.market,local) {
                locals.push(("目标市场当地语言",local.query.clone()));
            }
        }
        // Aliases are supplementary, never replacements for the user's words.
        let aliases: Vec<_> = variants.iter().skip(1).chain(self.aliases.iter()).filter(|a| super::lead_research::english_term(a) && a.to_lowercase() != p.to_lowercase()).take(3).collect();
        // Round-robin routes before applying a call limit. Several similar
        // English queries must not starve the task's actual buyer role or its
        // local-language route. No role selected means no invented wholesaler.
        let mut routes=vec![
            vec![("直接产品与买家",format!("{p} {role} {m}"))],
            self.task_plan.search_queries.iter().map(|q|("本次指令检索",q.clone())).collect(),
            locals,
            channels.iter().map(|channel|("潜在买家渠道",format!("{channel} {m}"))).collect(),
            aliases.iter().map(|alias|("产品别名",format!("{alias} {role} {m}"))).collect(),
            vec![("经营主体官网",format!("{p} {role} company website {m}")),
                 ("协会会员",format!("{p} {role} association member directory {m}")),
                 ("展会企业名录",format!("{p} {role} exhibitor directory {m}"))],
        ];
        // A later page explores additional *real sources*, not model-only names.
        if self.page > 1 {
            routes[5].push(("区域经营主体",format!("{p} {role} company contact {m}")));
            for alias in std::iter::once(&self.product).chain(self.aliases.iter()).take(4){
                for channel in channels.iter().take(4){routes[4].push(("产品与采购渠道",format!("{alias} {channel} {m}")));}
            }
            for route in &mut routes{if !route.is_empty(){let rotate=(self.page-1)%route.len();route.rotate_left(rotate);}}
        }
        let mut plans=vec![];
        for index in 0..routes.iter().map(Vec::len).max().unwrap_or(0){for route in &routes{if let Some(plan)=route.get(index){plans.push(plan.clone());}}}
        let mut seen = HashSet::new();
        plans.into_iter().filter(|(_,query)| !query.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c)) || super::lead_research::market_language(&self.market)=="ja")
            .map(|(channel, query)| QueryPlan { channel: channel.into(), query: compact(&query, 450) })
            .filter(|p| seen.insert(query_fingerprint(&p.query))).take(if self.batch_mode { 10 } else { 7 }).collect()
    }
}

/// Separate explicit lists of complete product phrases, not specifications
/// such as "IP67 LED driver, 24V 100W". Semantic review still gets the full input.
fn product_variants(product:&str)->Vec<String>{
    let parts:Vec<_>=product.split(',').map(str::trim).filter(|s|!s.is_empty()).collect();
    if parts.len()>1 && parts.iter().all(|p|p.split_whitespace().filter(|word|word.len()>1 && word.chars().all(|c|c.is_ascii_alphabetic()||c=='-')).count()>=2){
        parts.into_iter().take(4).map(str::to_string).collect()
    }else{vec![product.to_string()]}
}

pub fn query_fingerprint(query:&str)->String {
    // Operators/quoted phrases may change meaning; only normalize plain AND
    // term queries, not site exclusions, model numbers or exact phrases.
    if query.contains(['"',':','-','|','+']) || query.split_whitespace().any(|w|matches!(w,"OR"|"AND"|"NOT")) {
        return query.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    }
    let mut terms=words(query).iter().map(|w|singular(w)).collect::<Vec<_>>();terms.sort();terms.dedup();terms.join(" ")
}

pub fn market_keyword(market: &str) -> String {
    let mut result = market.to_string();
    for (native, english) in [("美国", "United States"), ("英国", "United Kingdom"), ("德国", "Germany"), ("法国", "France"), ("西班牙", "Spain"), ("意大利", "Italy"), ("葡萄牙", "Portugal"), ("巴西", "Brazil"), ("日本", "Japan"), ("加拿大", "Canada"), ("澳大利亚", "Australia"), ("荷兰", "Netherlands"), ("中国", "China")] {
        result = result.replace(native, english);
    }
    result
}

pub fn excludes_china(text: &str) -> bool {
    let s = text.to_lowercase();
    ["排除中国", "不要中国", "exclude china", "excluding china", "no chinese companies", "outside china"].iter().any(|p| s.contains(p))
}

pub fn host(url: &str) -> Option<String> {
    let u = reqwest::Url::parse(url).ok()?;
    if !matches!(u.scheme(), "http" | "https") || !u.username().is_empty() || u.password().is_some() { return None; }
    Some(u.host_str()?.trim_end_matches('.').trim_start_matches("www.").to_lowercase())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind { Company, Directory, Platform }

pub fn source_kind(url: &str, title: &str) -> SourceKind {
    let h = host(url).unwrap_or_default();
    if ["linkedin.com", "facebook.com", "instagram.com", "youtube.com", "amazon.com", "alibaba.com", "made-in-china.com", "wikipedia.org", "pinterest.com", "twitter.com", "x.com", "reddit.com", "quora.com", "google.com", "bing.com", "duckduckgo.com", "search.brave.com", "tradewheel.com", "dhgate.com", "everychina.com", "etsy.com", "faire.com", "supplyleader.com", "aliexpress.com", "temu.com", "walmart.com", "merriam-webster.com", "dictionary.cambridge.org", "vocabulary.com", "wiktionary.org"]
        .iter().any(|d| h == *d || h.ends_with(&format!(".{d}"))) { return SourceKind::Platform; }
    if h.starts_with("amazon.") || h.starts_with("ebay.") { return SourceKind::Platform; }
    let title_lower = title.to_lowercase();
    if title_lower.contains("marketplace") || h == "substack.com" || h.ends_with(".substack.com") { return SourceKind::Platform; }
    if h.starts_with("europages.") || h == "kompass.com" || h.ends_with(".kompass.com")
        || h.starts_with("yellowpages.")
        || ["thomasnet.com", "wlw.de", "yellowpages.com", "industrynet.com", "ensun.io", "tripadvisor.com", "yelp.com"].iter().any(|d| h == *d || h.ends_with(&format!(".{d}"))) {
        return SourceKind::Directory;
    }
    let s = format!("{} {}", reqwest::Url::parse(url).map(|u| u.path().to_string()).unwrap_or_default(), title).to_lowercase();
    let tokens:Vec<_>=s.split_whitespace().collect();
    let shop_roundup = (s.contains("/blog/") && ["gift-shops", "gift shops", "boutiques", "shops-artisans", "shop-small", "shopping"].iter().any(|term| s.contains(term)))
        || ["shops and brands", "shops around", "shops in ", "shops near ", "shops to ", "best independent gift shops"].iter().any(|term| title_lower.contains(term));
    if shop_roundup || tokens.windows(2).any(|p|p[0].parse::<u32>().is_ok() && matches!(p[1],"best"|"top")) || s.contains("things-to-do/") || s.contains("/best-") {
        return SourceKind::Directory;
    }
    if ["directory", "exhibitor list", "exhibitors", "member list", "members list", "/distributors", "/dealers", "/stockists", "where-to-buy", "参展商", "企业名录", "会员名录", "top 10", "top 20"]
        .iter().any(|p| s.contains(p)) { SourceKind::Directory } else { SourceKind::Company }
}

/// Narrow self-location signals only. Mentioning an overseas supplier's China
/// imports does not establish that the buyer is a Chinese company.
pub fn china_self_description(title:&str, text:&str)->bool {
    let t=title.to_lowercase(); let body=text.to_lowercase();
    let titled=(t.starts_with("china ") || t.contains("- china ") || t.contains("| china "))
        && ["manufacturer","factory","supplier","exporter"].iter().any(|s|t.contains(s));
    titled || ["based in china", "located in china", "factory in china", "manufacturer in china", "总部位于中国", "公司位于中国"].iter().any(|s|body.contains(s))
}

fn words(value: &str) -> Vec<String> {
    value.to_lowercase().split(|c: char| !c.is_alphanumeric() && c != '-')
        .filter(|s| !s.is_empty() && !["the", "and", "for", "with", "a", "an", "of", "to"].contains(s))
        .map(str::to_string).collect()
}

/// Unicode-aware and boundary-sensitive: LED must not match "ledgers".
pub fn contains_term(text: &str, term: &str) -> bool {
    let text = text.to_lowercase();
    let term = term.trim().to_lowercase();
    if term.is_empty() { return false; }
    let has_cjk = term.chars().any(|c| ('\u{3400}'..='\u{9fff}').contains(&c) || ('\u{3040}'..='\u{30ff}').contains(&c));
    if has_cjk { return text.contains(&term); }
    let hay: HashSet<_> = words(&text).iter().map(|w| singular(w)).collect();
    let needle = words(&term);
    !needle.is_empty() && needle.iter().all(|n| hay.contains(&singular(n)))
}

fn singular(word: &str) -> String {
    if word.len() > 4 {
        if let Some(base) = word.strip_suffix("ies") { return format!("{base}y"); }
        if ["xes", "ches", "shes", "sses"].iter().any(|ending| word.ends_with(ending)) { return word[..word.len()-2].to_string(); }
        if word.ends_with('s') && !word.ends_with("ss") { return word[..word.len()-1].to_string(); }
    }
    word.to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof { pub url: String, pub quote: String, pub kind: String }
#[derive(Debug, Clone, Default)]
#[derive(Serialize, Deserialize)]
pub struct Page { pub url: String, pub title: String, pub text: String }
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub level: String,
    pub score: u32,
    pub product_match: bool,
    pub buyer_match: bool,
    pub channel_match: bool,
    pub evidence: Vec<Proof>,
    pub unknowns: Vec<String>,
    pub checked_pages: usize,
}

fn excerpt(text: &str, needle: &str) -> Option<String> {
    // A quote must actually contain its terms, not just point to a page on
    // which the words occur far apart. Slice characters, never UTF-8 bytes.
    if !contains_term(text, needle) { return None; }
    let chars: Vec<char> = text.chars().collect();
    (0..chars.len()).step_by(250).find_map(|start| {
        let passage: String = chars[start..chars.len().min(start+600)].iter().collect();
        contains_term(&passage, needle).then_some(passage)
    })
}

pub fn assess(request: &LeadRequest, pages: &[Page]) -> Assessment {
    let mut result = Assessment { level: "needs_review".into(), checked_pages: pages.len(), ..Default::default() };
    let product_terms: Vec<&str> = std::iter::once(request.product.as_str()).chain(request.aliases.iter().map(String::as_str)).filter(|s| !s.is_empty()).collect();
    let role_terms: Vec<&str> = if request.buyer_type.trim().is_empty() {
        vec!["distributor", "wholesale", "wholesaler", "importer", "stockist", "retailer", "经销商", "批发商", "进口商", "distributeur", "grossiste", "großhandel", "mayorista", "distributore", "卸売"]
    } else {
        // Only aliases of the selected buyer role, not every possible role.
        let b = request.buyer_type.to_lowercase();
        if b.contains("distribut") || b.contains("经销") || b.contains("分销") { vec!["distributor", "distribution", "wholesale", "wholesaler", "经销商", "分销商", "批发商", "distributeur", "distribuidor", "distributore", "grossiste", "großhandel", "mayorista", "販売代理店"] }
        else if b.contains("wholesale") || b.contains("批发") { vec!["wholesale", "wholesaler", "批发", "grossiste", "großhandel", "mayorista", "grossista", "卸売"] }
        else if b.contains("import") || b.contains("进口") { vec!["importer", "importateur", "importador", "importeur", "进口", "輸入"] }
        else { vec![request.buyer_type.as_str()] }
    };
    for page in pages {
        let corpus = format!("{} {}", page.title, page.text);
        if let Some(quote) = product_terms.iter().find_map(|term| excerpt(&corpus, term)) {
            result.product_match = true;
            result.evidence.push(Proof { url: page.url.clone(), quote, kind: "product".into() });
        }
        if let Some(quote) = role_terms.iter().find_map(|role| {
            // A supplier saying "our customers are distributors" is not itself
            // a distributor. Require the title or a self-description passage.
            if contains_term(&page.title, role) { return excerpt(&corpus, role); }
            let quote = excerpt(&page.text, role)?;
            let lower = quote.to_lowercase();
            ["we are", "we're", "as a ", "our company", "your trusted", "we import", "we distribute", "本公司", "我们是", "专业批发", "nous sommes", "wir sind", "somos", "siamo"]
                .iter().any(|p| lower.contains(p)).then_some(quote)
        }) {
            result.buyer_match = true;
            result.evidence.push(Proof { url: page.url.clone(), quote, kind: "buyer_role".into() });
        }
        if let Some(quote) = request.channels.iter().find_map(|channel| excerpt(&corpus, channel)) {
            result.channel_match = true;
            result.evidence.push(Proof { url: page.url.clone(), quote, kind: "buyer_channel".into() });
        }
    }
    let corpus = pages.iter().map(|p| format!("{} {}", p.title, p.text)).collect::<Vec<_>>().join(" ");
    let missing: Vec<_> = request.qualifiers.iter().filter(|q| !contains_term(&corpus, q)).collect();
    let excluded: Vec<_> = request.exclusions.iter().filter(|q| contains_term(&corpus, q)).collect();
    if !result.product_match { result.unknowns.push("尚未从已读网页确认目标产品".into()); }
    if !result.buyer_match { result.unknowns.push("尚未确认所需买家/渠道身份；词语出现不等于采购意向".into()); }
    if !missing.is_empty() { result.unknowns.push(format!("产品限定待核实：{}", missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("、"))); }
    if !excluded.is_empty() { result.unknowns.push(format!("网页出现排除信号，需人工复核：{}", excluded.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("、"))); }
    result.unknowns.push("公司实际所在地、采购意向及注册身份尚未核实；目标市场不是所在地证据".into());
    let requirements=request.requirements.to_lowercase();
    if ["大型", "大公司", "跨国", "上市", "large compan", "multinational", "publicly traded"].iter().any(|s|requirements.contains(s)) {
        result.unknowns.push("规模、集团关系及是否上市尚待核实，不能认定已满足排除大企业的要求".into());
    }
    result.score = (if result.product_match { 50 } else { 0 }) + (if result.buyer_match { 20 } else { 0 }) + (if pages.len() > 1 { 5 } else { 0 });
    if result.product_match && result.buyer_match && missing.is_empty() && excluded.is_empty() {
        result.level = "source_matched".into();
    } else if result.channel_match && excluded.is_empty() {
        result.level = "channel_candidate".into();
        result.score = result.score.max(40).min(49);
        result.unknowns.push("属于潜在采购渠道；尚未证明其经营或需要该款具体产品".into());
    } else { result.score = result.score.min(49); }
    // No readable evidence is a pending lead, never a verified zero-risk company.
    result.evidence.truncate(6);
    result
}

#[cfg(test)]
mod tests {
    #[test]
    fn fallback_relevance_follows_the_current_product_and_requested_role() {
        assert!(super::fallback_relevance("Industrial pump engineering company", "industrial pump", ""));
        assert!(!super::fallback_relevance("Floral gift and home decor company", "industrial pump", ""));
        assert!(super::fallback_relevance("Floral gift and home decor company", "floral gift", ""));
        assert!(!super::fallback_relevance("Industrial pump engineering company", "floral gift", ""));
        assert!(super::fallback_relevance("Metal component procurement specialist", "precision tools", "procurement specialist"));
        assert!(!super::fallback_relevance("Floral gift and home decor company", "medical scanner", ""));
        assert!(!super::fallback_relevance("A supplier company in this market", "precision tools", "supplier"));
    }
    #[test] fn product_alternatives_are_not_one_impossible_and_query(){
        let r=LeadRequest{product:"Precision wrench, adjustable torque driver, digital pressure gauge".into(),buyer_type:"wholesaler".into(),batch_mode:true,..Default::default()};
        let queries=r.queries();assert!(queries.iter().any(|q|q.query=="Precision wrench wholesaler"));
        assert!(queries.iter().any(|q|q.query.contains("adjustable torque driver")));
        assert!(!queries.iter().any(|q|q.query.contains("wrench, adjustable torque")));
        assert_eq!(product_variants("IP67 LED driver, 24V 100W"),vec!["IP67 LED driver, 24V 100W"]);
        assert_eq!(r.product,"Precision wrench, adjustable torque driver, digital pressure gauge");
    }
    use super::*;
    #[test] fn cross_industry_roles_do_not_inherit_wholesale_importer_or_dealer_routes(){
        for(product,role)in[("hotel guest amenities","hotel operator"),("software localization services","software publisher"),("event audiovisual services","exhibition organizer"),("specialty chemicals","manufacturer"),("dental materials","dental clinic"),("commercial solar panels","contractor")]{
            let r=LeadRequest{product:product.into(),buyer_type:role.into(),channels:vec![role.into()],batch_mode:true,..Default::default()};
            for page in [1,2,3]{let mut next=r.clone();next.page=page;let q=next.queries();assert!(!q.is_empty());
                assert!(q.iter().all(|q|!["wholesale","importer","stockist","dealer"].iter().any(|word|q.query.contains(word))),"{product}: {q:?}");}
        }
        assert!(LeadRequest{product:"custom software development".into(),..Default::default()}.queries().iter().all(|q|!q.query.contains("wholesale")));
    }
    #[test] fn query_routes_share_the_early_slots_and_duplicate_words_do_not_spend_more_slots(){
        let mut r=LeadRequest{product:"industrial valves".into(),market:"Germany".into(),buyer_type:"distributor".into(),
            channels:vec!["industrial valve distributor".into(),"process equipment buyers".into()],local_queries:vec![LocalQuery{language:"de".into(),query:"Industriearmaturen Händler Deutschland".into()}],batch_mode:true,..Default::default()};
        r.task_plan.search_queries=vec!["industrial valve distributors Germany".into(),"Germany industrial valves distributor".into(),"process valves Germany distributor".into()];
        let q=r.queries();assert!(q.iter().take(3).any(|q|q.channel=="目标市场当地语言"));
        assert_eq!(q.iter().filter(|q|query_fingerprint(&q.query)==query_fingerprint("industrial valves distributor Germany")).count(),1);
        assert_ne!(query_fingerprint("valves -manufacturer"),query_fingerprint("valves manufacturer"));
        assert_ne!(query_fingerprint("\"valve control\""),query_fingerprint("\"control valve\""));
        assert_eq!(q.len(),q.iter().map(|q|query_fingerprint(&q.query)).collect::<HashSet<_>>().len());
    }
    fn request(p: &str) -> LeadRequest { LeadRequest { product: p.into(), market: "Germany".into(), ..Default::default() }.bounded() }
    fn page(s: &str) -> Page { Page { url: "https://example.org/products".into(), title: "Example".into(), text: s.into() } }
    #[test] fn preserves_english_and_specs() {
        let mut r = request("IP67 LED power supply 24V"); r.aliases = vec!["LED driver".into()];
        r.local_queries=vec![LocalQuery{language:"de".into(),query:"IP67 LED Netzteil Großhandel Deutschland".into()}];
        let q = r.queries(); assert!(q[0].query.contains("IP67 LED power supply 24V"));
        assert!(q.iter().any(|q| q.query.contains("LED driver")));
        assert!(q.iter().any(|q| q.query.contains("Großhandel")));
        assert!(!q.iter().any(|q| q.query.contains("gift") || q.query.contains("home decor")));
    }
    #[test] fn english_market_queries_and_native_pages_survive_relevance_floor() {
        let mut r = request("industrial pump"); r.market = "德国".into();
        assert!(r.queries().iter().any(|q| q.query.contains("Germany")));
        let hit = crate::Hit { title: "Industrial pumps Großhandel".into(), url: "https://example.org/".into(), description: "Handel".into(), provider: "fixture".into() };
        assert_eq!(crate::relevant_hits("industrial pump distributor Germany", vec![hit]).len(), 1);
        let hit = crate::Hit { title: "工业水泵批发".into(), url: "https://example.org/".into(), description: String::new(), provider: "fixture".into() };
        assert_eq!(crate::relevant_hits("工业水泵 distributor wholesaler China", vec![hit]).len(), 1);
    }
    #[test] fn chinese_and_english_proof_equivalent() {
        assert_eq!(assess(&request("工业水泵"), &[page("本公司是工业水泵进口商")]).level, "source_matched");
        assert_eq!(assess(&request("industrial pump"), &[page("We are an industrial pumps wholesaler")]).level, "source_matched");
    }
    #[test] fn avoids_substring_false_positive() {
        assert!(!contains_term("Our ledgers include supplies", "LED"));
        assert!(!contains_term("supplier of office supplies", "power supply"));
        assert!(contains_term("LED power supplies distributor", "LED power supply"));
        assert!(contains_term("food packaging boxes", "food packaging box"));
    }
    #[test] fn unrelated_buyers_not_high_matches() {
        let a = assess(&request("dental chair"), &[page("We are a gift wholesaler")]);
        assert!(!a.product_match); assert!(a.score < 50);
    }
    #[test] fn snippets_and_unread_pages_are_not_evidence() {
        let a = assess(&request("ceramic mug"), &[]);
        assert!(a.evidence.is_empty()); assert_eq!(a.level, "needs_review");
    }
    #[test] fn qualifiers_and_exclusions_cannot_be_ignored() {
        let mut r = request("industrial pump"); r.qualifiers = vec!["food grade".into()];
        assert_eq!(assess(&r, &[page("Industrial pump importer")]).level, "needs_review");
        r.qualifiers.clear(); r.exclusions = vec!["used equipment".into()];
        assert_eq!(assess(&r, &[page("Industrial pump importer used equipment")]).level, "needs_review");
    }
    #[test] fn directories_are_not_company_records() {
        assert_eq!(source_kind("https://event.org/exhibitors", "Companies"), SourceKind::Directory);
        assert_eq!(source_kind("https://www.europages.co.uk/companies/distributor/pump.html", "Pumps"), SourceKind::Directory);
        assert_eq!(source_kind("https://pump.org/products", "Pump manufacturer"), SourceKind::Company);
        assert_eq!(source_kind("https://linkedin.com/company/x", "X"), SourceKind::Platform);
        assert_eq!(source_kind("https://notlinkedin.com", "X"), SourceKind::Company);
        for url in ["https://www.dhgate.com/wholesale", "https://www.etsy.com/listing/1", "https://www.amazon.co.uk/item"] {
            assert_eq!(source_kind(url,"Flower Gifts"),SourceKind::Platform);
        }
    }
    #[test] fn explicit_china_suppliers_do_not_pass_a_country_exclusion() {
        assert!(china_self_description("Night Light - China Night Light Manufacturers Suppliers Factory",""));
        assert!(!china_self_description("UK Gift Importer","We import gifts from China for independent UK shops."));
    }
    #[test] fn best_shop_articles_and_reviews_are_routes_not_companies() {
        assert_eq!(source_kind("https://example.org/article", "15 Best Gift Shops in a City"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/things-to-do/shopping", "Gift Shops"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/102-things-to-do/gift-shops/", "Gift Shops"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/blog/artisan-goods-gift-shops-in-town/", "Gift Shops"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/blog/post/town-boutiques-gift-shops-artisans/", "Shopping"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/blog/shop-small-in-town/", "Visit Town"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/article", "13 Really Good Small Online Decor Shops To Make Your Home Unique"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/", "Home Decor Shops Around Town"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/", "Florists & Flower Shops in Town"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/", "Hidden Treasures: Best Independent Gift Shops in Town"),SourceKind::Directory);
        assert_eq!(source_kind("https://example.org/", "Curated Small Business Marketplace"),SourceKind::Platform);
        assert_eq!(source_kind("https://newsletter.substack.com/", "64 independent home shops and brands"),SourceKind::Platform);
        assert_eq!(source_kind("https://www.yellowpages.ca/", "Flowers"),SourceKind::Directory);
        assert_eq!(source_kind("https://www.tripadvisor.com/Attractions", "THE 15 BEST Shops"),SourceKind::Directory);
        assert_eq!(source_kind("https://www.reddit.com/r/gifts", "Where to shop"),SourceKind::Platform);
    }
    #[test] fn domain_identity_does_not_merge_co_uk_companies() {
        assert_ne!(host("https://one.co.uk/x"), host("https://two.co.uk/x"));
        assert_eq!(host("https://www.EXAMPLE.org/path"), Some("example.org".into()));
    }
    #[test] fn selected_buyer_type_is_required() {
        let mut r = request("industrial pump"); r.buyer_type = "importer".into();
        assert!(!assess(&r, &[page("Industrial pump manufacturer")]).buyer_match);
    }
    #[test] fn suppliers_customer_roles_are_not_its_own_buyer_identity() {
        let a = assess(&request("industrial pump"), &[page("Industrial pumps for international buyers, distributors and project partners.")]);
        assert!(!a.buyer_match); assert_eq!(a.level, "needs_review");
    }
    #[test] fn no_market_as_company_country_claim() {
        let a = assess(&request("solar panel"), &[page("Solar panel distributor")]);
        assert!(a.unknowns.iter().any(|s| s.contains("所在地")));
    }
    #[test] fn document_led_prospecting_searches_channels_without_demanding_the_same_product() {
        let r = LeadRequest { product: "Sample Accent Lamp (Accent Lighting / Music Box / Bluetooth Speaker)".into(),
            channels: vec!["gift shops".into(), "decor wholesalers".into()], aliases: vec!["accent lamp".into()],
            requirements: "排除中国公司".into(), batch_mode: true, ..Default::default() }.bounded();
        let plans = r.queries();
        assert!(plans.iter().take(3).any(|p| p.channel == "潜在买家渠道" && p.query.starts_with("gift shops")));
        assert!(plans.iter().any(|p| p.query.starts_with("decor wholesalers")));
        assert!(!plans.iter().any(|p| p.query.contains("Music Box / Bluetooth Speaker")));
        let result = assess(&r, &[page("We are an independent gift shop offering botanical gifts and home decor.")]);
        assert!(result.channel_match); assert!(!result.product_match);
        assert_eq!(result.level,"channel_candidate"); assert!(result.score < 50);
    }
    #[test] fn raw_business_words_do_not_trigger_fixed_country_or_size_filters() {
        let r = LeadRequest { product: "botanical gifts".into(), aliases: vec!["botanical gifts".into()],
            channels: vec!["gift shops".into(), "flower shops".into(), "home decor retailers".into()],
            requirements: "不排除中国，也不排除超大型跨国公司、大型公司".into(), batch_mode: true, ..Default::default() }.bounded();
        let plans = r.queries();
        assert_eq!(plans.iter().filter(|p| p.channel == "潜在买家渠道" && p.query.starts_with("independent ")).count(), 0);
        assert!(plans.iter().all(|p|!p.query.contains("-site:.cn")));
    }
    #[test] fn overseas_plans_prioritize_english_and_explicit_market_language() {
        let r=LeadRequest{product:"industrial pump".into(),market:"德国".into(),buyer_type:"进口商".into(),channels:vec!["工业设备进口商".into(),"industrial equipment importers".into()],
            local_queries:vec![LocalQuery{language:"de".into(),query:"Industriepumpen Großhandel Deutschland".into()},LocalQuery{language:"zh".into(),query:"德国水泵进口商".into()}],..Default::default()}.bounded();
        let plans=r.queries();assert!(plans[0].query.contains("industrial pump importer Germany"));
        assert!(plans.iter().take(3).any(|p|p.query.contains("Industriepumpen")));
        assert!(plans.iter().all(|p|!p.query.chars().any(|c|('\u{3400}'..='\u{9fff}').contains(&c))));
        let r=LeadRequest{product:"IP67 LED driver 24V".into(),market:"France".into(),local_queries:vec![LocalQuery{language:"fr".into(),query:"alimentation LED distributeur France".into()}],..Default::default()}.bounded();
        assert!(r.queries().iter().any(|p|p.query.contains("IP67 LED driver 24V")));assert!(r.queries().iter().any(|p|p.query.contains("distributeur France")));
    }
}
