//! Public-evidence collection. Never reads mail or user documents.
use super::company_intel;
use crate::state::AppState;
use pebble_websearch::{company_profile::{self,ResearchQuery},investigation::{self,Investigation,QueryAudit,ReadAudit},leads::Page,Hit};
use std::{collections::HashSet,time::Duration};
use tokio::time::{Instant,timeout_at};

#[derive(Default)]
pub struct Gathered{
    pub website:String,pub country:String,pub title:String,pub description:String,pub emails:Vec<String>,
    pub pages:Vec<Page>,pub hits:Vec<Hit>,pub audit:Investigation,pub warnings:Vec<String>,
    pub page_times:std::collections::HashMap<String,i64>,
}
/// Follow actual links in a read registry record, not model-invented URLs.
/// Stay under that entity's path; search/login/other-company links are excluded.
fn registry_document_links(html:&str,url:&str,title:&str)->Vec<Hit>{
    if !matches!(investigation::category(url),"registry"|"financial"){return vec![];}
    let Ok(base)=reqwest::Url::parse(url)else{return vec![];};
    let segments:Vec<_>=base.path().trim_matches('/').split('/').collect();if segments.len()<2{return vec![];}
    let prefix=format!("/{}/{}/",segments[0],segments[1]);
    let doc=scraper::Html::parse_document(html);let Ok(selector)=scraper::Selector::parse("a[href]")else{return vec![];};
    let mut hits=vec![];
    for node in doc.select(&selector){
        let Some(raw)=node.value().attr("href")else{continue;};let Ok(mut link)=base.join(raw)else{continue;};
        let text=node.text().collect::<Vec<_>>().join(" ").to_lowercase();let path=link.path().to_lowercase();
        if link.host_str()!=base.host_str() || !path.starts_with(&prefix.to_lowercase()) || link.query().is_some() || !matches!(link.scheme(),"https"|"http"){continue;}
        if !["filing-history","accounts","financial","officers","significant-control","annual-report"].iter().any(|word|path.contains(word)||text.contains(word)){continue;}
        link.set_fragment(None);let value=link.to_string();if value==url||hits.iter().any(|h:&Hit|h.url==value){continue;}
        hits.push(Hit{url:value,title:title.into(),description:node.text().collect::<Vec<_>>().join(" "),provider:"registry / linked record".into()});
    }
    hits.sort_by_key(|h|usize::from(!h.url.contains("filing-history")&&!h.url.contains("accounts")));hits.truncate(4);hits
}
async fn search_batch(state:&AppState,client:&reqwest::Client,queries:&[ResearchQuery],deadline:Instant,data:&mut Gathered){
    async fn one(state:&AppState,client:&reqwest::Client,q:&ResearchQuery,deadline:Instant)->(ResearchQuery,pebble_websearch::SearchResult){
        (q.clone(),company_intel::search_one(state,client,q,deadline).await)
    }
    let mut results=vec![];
    match queries{
        []=>{},[a]=>results.push(one(state,client,a,deadline).await),
        [a,b]=>{let(x,y)=tokio::join!(one(state,client,a,deadline),one(state,client,b,deadline));results.extend([x,y]);},
        [a,b,c,..]=>{let(x,y,z)=tokio::join!(one(state,client,a,deadline),one(state,client,b,deadline),one(state,client,c,deadline));results.extend([x,y,z]);},
    }
    for (query,result) in results{
        let completed=!result.items.is_empty() || result.attempts.iter().any(|a|matches!(a.status.as_str(),"成功"|"无命中"|"结果相关性不足／链接不安全"));
        data.audit.queries.push(QueryAudit{facet:query.facet,query:query.text,hits:result.items.len(),completed,warning:result.warning.clone()});
        if !result.warning.is_empty(){data.warnings.push(result.warning);}
        data.hits.extend(result.items);
    }
    data.hits=company_profile::merge_research_hits(std::mem::take(&mut data.hits));
}
async fn read_batch(state:&AppState,client:&reqwest::Client,name:&str,urls:&[String],attempted:&mut HashSet<String>,deadline:Instant,data:&mut Gathered){
    async fn one(state:&AppState,client:&reqwest::Client,url:&str,deadline:Instant)->(String,Option<(String,String,Page)>){
        (url.into(),company_intel::fetch_text_page(state,client,url,deadline).await)
    }
    let urls:Vec<_>=urls.iter().filter(|u|!attempted.contains(*u)).take(3).cloned().collect();
    for url in &urls{attempted.insert(url.clone());}
    let mut results=vec![];
    match urls.as_slice(){
        []=>{},[a]=>results.push(one(state,client,a,deadline).await),
        [a,b]=>{let(x,y)=tokio::join!(one(state,client,a,deadline),one(state,client,b,deadline));results.extend([x,y]);},
        [a,b,c,..]=>{let(x,y,z)=tokio::join!(one(state,client,a,deadline),one(state,client,b,deadline),one(state,client,c,deadline));results.extend([x,y,z]);},
    }
    for (url,result) in results{
        let facet=data.hits.iter().find(|h|h.url==url).map(|h|h.provider.split(" / ").next().unwrap_or("business").to_string()).unwrap_or_else(||"identity".into());
        let Some((final_url,html,page))=result else{data.audit.reads.push(ReadAudit{url,facet,outcome:"unavailable".into()});continue;};
        attempted.insert(final_url.clone());
        let same=investigation::site_key(&final_url)==investigation::site_key(&data.website);
        let direct=company_profile::mentions_company(name,&format!("{} {}",page.title,page.text)) || (!data.website.is_empty() && page.text.to_lowercase().contains(&company_profile::domain_of(&data.website)));
        // A person alone may be a namesake. Only two independently extracted
        // non-country facts can connect a person-only article to this company.
        let linked=data.audit.anchors.iter().filter(|a|matches!(a.kind.as_str(),"person"|"registration"|"address") && a.value.chars().count()>=6 && page.text.to_lowercase().contains(&a.value.to_lowercase())).count()>=2;
        let outcome=if data.pages.iter().any(|p|p.url==final_url){"already_read"}
            else if !same && !direct && !linked{"identity_unconfirmed"}
            else if investigation::duplicate(&data.pages,&page){data.audit.duplicate_pages+=1;"duplicate_content"}
            else if data.pages.len()>=company_intel::MAX_EVIDENCE_PAGES{"limit_reached"}
            else{
                if same{data.emails.extend(company_intel::public_emails(&html));}
                data.hits.extend(registry_document_links(&html,&final_url,&page.title));
                data.page_times.insert(page.url.clone(),pebble_core::now_timestamp());
                data.pages.push(page);"read"
            };
        data.audit.reads.push(ReadAudit{url:final_url,facet,outcome:outcome.into()});
    }
}
async fn collect_external(state:&AppState,client:&reqwest::Client,name:&str,attempted:&mut HashSet<String>,deadline:Instant,data:&mut Gathered,target:usize){
    let mut waves=0;
    while Instant::now()+Duration::from_secs(5)<deadline && data.pages.len()<company_intel::MAX_EVIDENCE_PAGES && attempted.len()<48{
        for hit in &data.hits{
            if reqwest::Url::parse(&hit.url).ok().and_then(|u|u.host_str().map(company_intel::unreadable_host))==Some(true){attempted.insert(hit.url.clone());}
        }
        let external=data.pages.iter().filter(|p|investigation::site_key(&p.url)!=investigation::site_key(&data.website)).count();
        if external>=target.min(company_intel::MAX_EXTERNAL_PAGES){break;}
        let mut targets=investigation::targets(&data.hits,name,&data.website,&data.audit.anchors,&data.pages,attempted,(target-external).min(3),true);
        targets.retain(|u|reqwest::Url::parse(u).ok().and_then(|u|u.host_str().map(company_intel::unreadable_host))!=Some(true));
        // Mark known login-wall candidates as attempted, not silently retry them.
        if targets.is_empty(){break;}
        read_batch(state,client,name,&targets,attempted,deadline,data).await;waves+=1;if waves>=12{break;}
    }
}

pub async fn gather(state:&AppState,client:&reqwest::Client,name:&str,website:&str,country:&str,deadline:Instant,progress:Option<&(dyn Fn(String)+Send+Sync)>)->Gathered{
    if let Some(c)=progress{c("正在确认公司主体".into());}
    let mut data=Gathered{website:website.into(),country:country.into(),..Default::default()};
    let mut attempted=HashSet::new();
    let identities=company_profile::query_plan(name,website,country,"");
    // A supplied public site can be read directly. Reserve the bounded API
    // requests for independent evidence instead of rediscovering that same site.
    if website.trim().is_empty(){search_batch(state,client,&identities[..identities.len().min(2)],deadline,&mut data).await;}
    let candidates=if data.website.is_empty(){company_profile::official_site_candidates(name,&data.hits)}else{vec![data.website.clone()]};
    let mut site_links=vec![];
    for url in candidates.into_iter().take(2){
        // Keep the returned branded domain as a discovery hint even if its
        // home page is unavailable. Otherwise its readable inner pages would
        // be counted as independent external evidence. This is not registry
        // verification; all admitted bodies remain source disclosures.
        if data.website.is_empty(){data.website=url.clone();}
        attempted.insert(url.clone());
        match company_intel::fetch_text_page(state,client,&url,deadline).await{
            Some((final_url,html,page))=>{
                if website.is_empty() && !company_profile::mentions_company(name,&format!("{} {}",page.title,page.text)){continue;}
                data.website=final_url.clone();data.title=page.title.clone();data.description=company_intel::meta_description(&html);
                data.emails.extend(company_intel::public_emails(&html));site_links=company_intel::research_page_urls(&html,&final_url);
                data.page_times.insert(page.url.clone(),pebble_core::now_timestamp());
                data.audit.reads.push(ReadAudit{url:final_url,facet:"identity".into(),outcome:"read".into()});data.pages.push(page);break;
            },
            None=>data.audit.reads.push(ReadAudit{url,facet:"identity".into(),outcome:"unavailable".into()}),
        }
    }
    // Reuse recent evidence already read for this exact company/site by the
    // contact workflow. Do not reuse another company on a shared host.
    for cached in super::research_evidence::cached_pages(state,name,&data.website) {
        if data.pages.len()>=company_intel::MAX_EVIDENCE_PAGES || data.pages.iter().filter(|p|investigation::site_key(&p.url)==investigation::site_key(&data.website)).count()>=company_intel::MAX_SITE_PAGES {break;}
        let page=cached.page;
        if investigation::site_key(&page.url)!=investigation::site_key(&data.website) || data.pages.iter().any(|p|p.url==page.url){continue;}
        attempted.insert(page.url.clone());
        data.emails.extend(company_intel::public_emails(&page.text));
        data.audit.reads.push(ReadAudit{url:page.url.clone(),facet:"shared_public_evidence".into(),outcome:"cached".into()});
        data.page_times.insert(page.url.clone(),cached.fetched_at);
        data.pages.push(page);
    }
    // External discovery comes before reading a long queue of website products.
    if let Some(c)=progress{c("正在查找独立资料".into());}
    let first=investigation::external_queries(name,&data.website,country);
    for chunk in first.chunks(3){if Instant::now()+Duration::from_secs(5)>=deadline{break;}search_batch(state,client,chunk,deadline,&mut data).await;}
    site_links.sort_by_key(|u|(company_profile::research_page_priority(u),u.clone()));site_links.dedup();
    let own_count=data.pages.iter().filter(|p|investigation::site_key(&p.url)==investigation::site_key(&data.website)).count();
    let links:Vec<_>=site_links.into_iter().filter(|u|!attempted.contains(u)).take(3.min(company_intel::MAX_SITE_PAGES.saturating_sub(own_count))).collect();
    let mut official=Gathered{website:data.website.clone(),..Default::default()};
    let mut external=Gathered{website:data.website.clone(),hits:data.hits.clone(),..Default::default()};
    let(mut own_attempts,mut ext_attempts)=(attempted.clone(),attempted.clone());
    if let Some(c)=progress{c("正在读取外部证据".into());}
    tokio::join!(
        read_batch(state,client,name,&links,&mut own_attempts,deadline,&mut official),
        collect_external(state,client,name,&mut ext_attempts,deadline,&mut external,5)
    );
    attempted.extend(own_attempts);attempted.extend(ext_attempts);
    data.pages.extend(official.pages);data.pages.extend(external.pages);data.emails.extend(official.emails);
    data.page_times.extend(official.page_times);data.page_times.extend(external.page_times);
    data.hits.extend(external.hits);data.hits=company_profile::merge_research_hits(std::mem::take(&mut data.hits));
    data.audit.reads.extend(official.audit.reads);data.audit.reads.extend(external.audit.reads);data.audit.duplicate_pages+=external.audit.duplicate_pages;

    // One evidence-grounded planning call. Later phases reuse these extracted
    // identities instead of interpreting the task from scratch per query.
    if !data.pages.is_empty() && Instant::now()+Duration::from_secs(15)<deadline{
        if let Some(c)=progress{c("正在追查人物和登记线索".into());}
        let payload=investigation::planning_user(name,&data.website,country,&data.pages,&data.audit.queries);
        match timeout_at(deadline.min(Instant::now()+Duration::from_secs(28)),company_intel::lead_research_completion(state,investigation::PLAN_SYSTEM,&payload)).await{
            Ok(Ok(raw))=>match investigation::parse_plan(&raw,name,&data.website,&data.pages,&data.audit.queries){
                Ok(plan)=>{
                    data.audit.anchors=plan.anchors;
                    if data.country.is_empty(){data.country=data.audit.anchors.iter().find(|a|a.kind=="country").map(|a|a.value.clone()).unwrap_or_default();}
                    let mut follow=plan.queries;
                    // A newly evidenced country can route to its own public
                    // registry without the user configuring a national API.
                    if !data.country.is_empty() && country.is_empty(){follow.extend(investigation::external_queries(name,&data.website,&data.country).into_iter().take(1));}
                    follow.retain(|q|!data.audit.queries.iter().any(|old|old.query==q.text));follow.truncate(7);
                    for chunk in follow.chunks(3){if Instant::now()+Duration::from_secs(5)>=deadline{break;}
                        data.audit.follow_up_queries+=chunk.len();search_batch(state,client,chunk,deadline,&mut data).await;
                        collect_external(state,client,name,&mut attempted,deadline,&mut data,10).await;
                    }
                },
                Err(_)=>data.warnings.push("补充调查规划未通过原文依据检查，保留已读资料并继续常规取证".into()),
            },
            _=>data.warnings.push("补充调查规划未完成，已读资料保留，未猜测关联主体".into()),
        }
    }
    collect_external(state,client,name,&mut attempted,deadline,&mut data,company_intel::MAX_EXTERNAL_PAGES).await;
    // Website pages fill only unused capacity, never the reserved external slots.
    let own=data.pages.iter().filter(|p|investigation::site_key(&p.url)==investigation::site_key(&data.website)).count();
    if !data.website.is_empty() && own<company_intel::MAX_SITE_PAGES && Instant::now()+Duration::from_secs(5)<deadline{
        let own_hits:Vec<_>=data.hits.iter().filter(|h|investigation::site_key(&h.url)==investigation::site_key(&data.website)).cloned().collect();
        let targets=investigation::targets(&own_hits,name,&data.website,&data.audit.anchors,&data.pages,&attempted,(company_intel::MAX_SITE_PAGES-own).min(3),false);
        read_batch(state,client,name,&targets,&mut attempted,deadline,&mut data).await;
    }
    data.emails.retain(|e|company_intel::is_usable_discovered_email(e));data.emails.sort();data.emails.dedup();
    data.audit.finish(&data.website,&data.pages);data
}

#[cfg(test)]mod tests{
    #[test]fn registry_followup_stays_on_the_same_record_and_never_builds_urls(){
        let html=r#"<a href="/company/123/filing-history">Accounts</a><a href="/company/123/officers">Officers</a><a href="/company/456/filing-history">Other company</a><a href="https://private.invalid/financial">Financials</a><a href="/login">Accounts login</a>"#;
        let hits=super::registry_document_links(html,"https://find-and-update.company-information.service.gov.uk/company/123","Sample Devices Ltd");
        assert_eq!(hits.len(),2);assert!(hits[0].url.ends_with("/123/filing-history"));assert!(hits.iter().all(|h|h.url.contains("/company/123/")));
        assert!(super::registry_document_links(html,"https://store.invalid/company/123","Sample Devices").is_empty());
    }
}
