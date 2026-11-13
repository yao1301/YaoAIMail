//! Shared, encrypted, profile-local evidence cache for discovery and investigation.
//! Only already-read public pages enter this cache; no mailbox or local-file access.
use crate::state::AppState;
use pebble_websearch::{contact_research::{self,ContactReview},leads::Page};
use serde::{Deserialize,Serialize};
use std::{hash::{Hash,Hasher},sync::Mutex};
const KEY:&str="research_public_evidence_v2";
static LOCK:Mutex<()>=Mutex::new(());
#[derive(Clone,Serialize,Deserialize)]
struct Entry { company:String, site:String, at:i64, pages:Vec<TimedPage>, fingerprint:u64, review:ContactReview }
#[derive(Clone,Serialize,Deserialize)]
pub(crate) struct TimedPage {pub page:Page,pub fetched_at:i64}
fn identity(name:&str,site:&str)->(String,String){
    // Legal suffixes and full host remain part of identity. US/UK subsidiaries
    // sharing a root domain are not implicitly the same entity.
    let name=name.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    let site=full_host(site);(name,site)
}
fn full_host(site:&str)->String{reqwest::Url::parse(site).ok().and_then(|u|u.host_str().map(|h|h.trim_start_matches("www.").to_lowercase())).unwrap_or_default()}
fn load(state:&AppState)->Result<Vec<Entry>,String>{
    let Some(blob)=state.store.get_secure_user_data(KEY).map_err(|_|"公开研究缓存读取失败")?else{return Ok(vec![])};
    if blob.len()>16*1024*1024{return Err("公开研究缓存过大，原记录未覆盖".into());}
    let plain=state.crypto.decrypt(&blob).map_err(|_|"公开研究缓存解密失败")?;
    serde_json::from_slice(&plain).map_err(|_|"公开研究缓存损坏，未覆盖原记录".into())
}
pub(crate) fn cached_pages(state:&AppState,name:&str,site:&str)->Vec<TimedPage>{
    let key=identity(name,site);if key.0.is_empty()||key.1.is_empty(){return vec![];}
    let Ok(_guard)=LOCK.lock()else{return vec![]};
    load(state).ok().and_then(|rows|rows.into_iter().find(|e|(e.company.clone(),e.site.clone())==key && fresh(e.at,pebble_core::now_timestamp())))
        .map(|e|fresh_pages(e.pages,pebble_core::now_timestamp(),&key.1)).unwrap_or_default()
}
/// Preserve already-read first-party pages independently of optional people
/// extraction. A zero fingerprint means pages-only, not a reviewed empty result.
pub(crate) fn remember_pages(state:&AppState,name:&str,site:&str,pages:&[Page]) {
    let(company,host)=identity(name,site);if company.is_empty()||host.is_empty(){return}
    let now=pebble_core::now_timestamp();let Ok(_guard)=LOCK.lock()else{return};let Ok(mut all)=load(state)else{return};
    let old=all.iter().find(|e|e.company==company&&e.site==host);
    let mut timed=old.map(|e|fresh_pages(e.pages.clone(),now,&host)).unwrap_or_default();
    for page in pages.iter().filter(|p|full_host(&p.url)==host).take(16){
        let page=Page{url:page.url.clone(),title:page.title.clone(),text:page.text.chars().take(7000).collect()};
        if timed.iter().any(|p|p.page.url==page.url&&p.page.text==page.text){continue}
        timed.retain(|p|p.page.url!=page.url);timed.push(TimedPage{page,fetched_at:now});
    }
    timed.truncate(16);if timed.is_empty(){return}
    let signature=fingerprint(&timed.iter().map(|p|p.page.clone()).collect::<Vec<_>>());
    let unchanged=old.is_some_and(|e|e.fingerprint==signature);
    let review=if unchanged{old.unwrap().review.clone()}else{Default::default()};
    let at=timed.iter().map(|p|p.fetched_at).max().unwrap_or(now);
    all.retain(|e|e.company!=company||e.site!=host);all.push(Entry{company,site:host,at,pages:timed,fingerprint:if unchanged{signature}else{0},review});
    if all.len()>30{all.drain(..all.len()-30);}if let Ok(bytes)=serde_json::to_vec(&all){if let Ok(blob)=state.crypto.encrypt(&bytes){let _=state.store.set_secure_user_data(KEY,&blob);}}
}
fn fresh(at:i64,now:i64)->bool{now>=at && now-at<=30*60}
fn fresh_pages(pages:Vec<TimedPage>,now:i64,host:&str)->Vec<TimedPage>{pages.into_iter().filter(|p|fresh(p.fetched_at,now)&&full_host(&p.page.url)==host).collect()}
fn fingerprint(pages:&[Page])->u64{
    let mut hash=std::collections::hash_map::DefaultHasher::new();
    for p in pages{p.url.hash(&mut hash);p.text.hash(&mut hash);}hash.finish()
}
pub(crate) async fn review_pages(state:&AppState,name:&str,site:&str,pages:&[Page])->ContactReview{
    review_pages_at(state,name,site,pages,&Default::default()).await
}
pub(crate) async fn review_pages_at(state:&AppState,name:&str,site:&str,pages:&[Page],times:&std::collections::HashMap<String,i64>)->ContactReview{
    if name.trim().is_empty()||site.trim().is_empty()||pages.is_empty(){return Default::default();}
    let(company,site_key)=identity(name,site);if company.is_empty()||site_key.is_empty(){return Default::default();}
    let now=pebble_core::now_timestamp();
    let timed=pages.iter().take(16).map(|p|TimedPage{page:Page{url:p.url.clone(),title:p.title.clone(),text:p.text.chars().take(7000).collect()},fetched_at:times.get(&p.url).copied().unwrap_or(now)})
        .filter(|p|fresh(p.fetched_at,now)).collect::<Vec<_>>();
    let pages=timed.iter().map(|p|p.page.clone()).collect::<Vec<_>>();
    if pages.is_empty(){return Default::default();}
    let signature=fingerprint(&pages);
    if let Ok(_guard)=LOCK.lock(){if let Ok(rows)=load(state){
        if let Some(e)=rows.iter().find(|e|e.company==company&&e.site==site_key&&e.fingerprint==signature&&fresh(e.at,now)){return e.review.clone();}
    }}
    let payload=serde_json::json!({"company":name,"website":site,"pages":pages});
    let raw=tokio::time::timeout(std::time::Duration::from_secs(18),super::company_intel::lead_research_completion(state,contact_research::REVIEW_SYSTEM,&payload.to_string())).await;
    let mut review=match raw {Ok(Ok(text))=>match contact_research::parse_review(&text,&pages,now){Ok(r)=>r,Err(_)=>return Default::default()},_=>return Default::default()};
    for p in &mut review.contacts {p.observed_at=timed.iter().find(|t|t.page.url==p.source_url).map(|t|t.fetched_at).unwrap_or(now);}
    for s in &mut review.buying_signals {s.observed_at=timed.iter().find(|t|t.page.url==s.source_url).map(|t|t.fetched_at).unwrap_or(now);}
    if let Ok(_guard)=LOCK.lock(){if let Ok(mut rows)=load(state){
        rows.retain(|e|!(e.company==company&&e.site==site_key));
        rows.push(Entry{company,site:site_key,at:now,pages:timed,fingerprint:signature,review:review.clone()});
        if rows.len()>30{rows.drain(..rows.len()-30);}
        if let Ok(plain)=serde_json::to_vec(&rows){if let Ok(blob)=state.crypto.encrypt(&plain){let _=state.store.set_secure_user_data(KEY,&blob);}}
    }}review
}
#[cfg(test)]mod tests{
    #[test]fn cache_identity_is_company_and_public_suffix_aware(){
        assert_ne!(super::identity("Sample Tools","https://a.example.com.ar"),super::identity("Other Tools","https://a.example.com.ar"));
        assert_ne!(super::identity("Sample Tools","https://tenant-a.github.io"),super::identity("Sample Tools","https://tenant-b.github.io"));
        assert_ne!(super::identity("Sample Inc","https://us.sample.invalid"),super::identity("Sample Ltd","https://uk.sample.invalid"));
        assert_ne!(super::identity("Sample Inc","https://sample.invalid"),super::identity("Sample Ltd","https://sample.invalid"));
    }
    #[test]fn cache_never_accepts_future_or_expired_timestamps(){assert!(super::fresh(100,120));assert!(!super::fresh(120,100));assert!(!super::fresh(0,1801));}
    #[test]fn rereviewing_a_collection_cannot_renew_its_old_personnel_pages(){
        let old=super::TimedPage{page:pebble_websearch::leads::Page{url:"https://us.sample.invalid/team".into(),title:"Team".into(),text:"Old public team page".into()},fetched_at:100};
        assert!(super::fresh_pages(vec![old.clone()],1901,"us.sample.invalid").is_empty());
        assert!(super::fresh_pages(vec![old.clone()],120,"uk.sample.invalid").is_empty());
        assert_eq!(super::fresh_pages(vec![old],120,"us.sample.invalid")[0].fetched_at,100);
    }
}
