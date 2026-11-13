//! Free conservative pre-screening. A mail route is NOT mailbox verification.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, time::Duration};
use crate::contact_research::DeliveryStatus;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all="snake_case")]
pub enum ScreenStatus { Passed, Invalid, Unknown }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct EmailScreen { pub email:String, pub status:ScreenStatus, pub reason:String, pub checked_at:i64 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct EmailVerification {
    pub email:String, pub delivery_status:DeliveryStatus, pub verification_provider:String,
    pub checked_at:i64, pub provider_date:Option<String>, pub reason:String,
    #[serde(default)]pub reason_code:String,
}

pub fn contact_block(screen:Option<&EmailScreen>,verification:Option<&EmailVerification>,feedback:Option<&str>,now:i64)->Option<&'static str>{
    match feedback{Some("unsubscribe")=>return Some("已记录对方退订，请勿继续开发联系"),Some("hard_bounce")=>return Some("已人工记录永久退信，请先核实并解除标记"),_=>{}}
    if screen.is_some_and(|s|s.status==ScreenStatus::Invalid && s.checked_at<=now && now-s.checked_at<900){return Some("邮箱基础初筛不通过");}
    if verification.is_some_and(|v|matches!(v.delivery_status,DeliveryStatus::Invalid|DeliveryStatus::Disposable) || v.reason_code=="claimed_email"){return Some("验证结果不建议继续联系，请核实邮箱");}
    None
}

/// Unsupported exotic addresses are unknown, not falsely rejected.
pub fn address_domain(email:&str)->Result<String,ScreenStatus> {
    let email=email.trim();
    if email.len()>254 {return Err(ScreenStatus::Invalid);}
    let (local,domain)=email.rsplit_once('@').ok_or(ScreenStatus::Invalid)?;
    if local.is_empty() || local.len()>64 || domain.is_empty() {return Err(ScreenStatus::Invalid);}
    if local.starts_with('"') || !local.is_ascii() || domain.starts_with('[') {return Err(ScreenStatus::Unknown);}
    if email.matches('@').count()!=1{return Err(ScreenStatus::Invalid);}
    if local.starts_with('.') || local.ends_with('.') || local.contains("..")
        || !local.bytes().all(|b|b.is_ascii_alphanumeric() || b".!#$%&'*+-/=?^_`{|}~".contains(&b)) {return Err(ScreenStatus::Invalid);}
    let host=reqwest::Url::parse(&format!("https://{domain}/")).ok()
        .and_then(|url|url.host_str().map(str::to_owned)).ok_or(ScreenStatus::Invalid)?;
    if !host.contains('.') {return Err(ScreenStatus::Unknown);}
    if domain.contains(['/',':','?','#','%','@','\\']) || domain.chars().any(char::is_whitespace)
        || host.parse::<std::net::IpAddr>().is_ok()
        || host.split('.').any(|label|label.is_empty() || label.len()>63 || label.starts_with('-') || label.ends_with('-') || !label.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-')) {return Err(ScreenStatus::Invalid);}
    Ok(host.to_ascii_lowercase())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DnsAnswer { Records(Vec<String>), Missing, NxDomain, Unknown }

pub fn parse_dns(body:&Value, domain:&str, kind:u64)->DnsAnswer {
    if body.get("TC").and_then(Value::as_bool)==Some(true) {return DnsAnswer::Unknown;}
    // Check question/owner attribution, including a bounded CNAME chain.
    let same=|a:&str,b:&str|a.trim_end_matches('.').eq_ignore_ascii_case(b.trim_end_matches('.'));
    let question=body.get("Question").and_then(Value::as_array);
    if !question.is_some_and(|q|q.iter().any(|q|same(q["name"].as_str().unwrap_or(""),domain) && q["type"].as_u64()==Some(kind))) {return DnsAnswer::Unknown;}
    match body.get("Status").and_then(Value::as_u64) {
        Some(3)=>return DnsAnswer::NxDomain, Some(0)=>{}, _=>return DnsAnswer::Unknown,
    }
    let records=body.get("Answer").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut owner=domain.to_string();
    for _ in 0..8 {
        let matching=records.iter().filter(|r|same(r["name"].as_str().unwrap_or(""),&owner)).collect::<Vec<_>>();
        let values=matching.iter().filter(|r|r["type"].as_u64()==Some(kind)).filter_map(|r|r["data"].as_str().map(str::to_owned)).collect::<Vec<_>>();
        if !values.is_empty(){return DnsAnswer::Records(values);}
        if let Some(alias)=matching.iter().find(|r|r["type"].as_u64()==Some(5)).and_then(|r|r["data"].as_str()) {owner=alias.into();}else{return DnsAnswer::Missing;}
    }
    DnsAnswer::Unknown
}

pub fn judge_domain(mx:&DnsAnswer, a:&DnsAnswer, aaaa:&DnsAnswer)->(ScreenStatus,&'static str) {
    match mx {
        DnsAnswer::NxDomain=>(ScreenStatus::Invalid,"域名不存在（DNS NXDOMAIN）"),
        DnsAnswer::Records(records)=>{
            if records.len()==1 && records[0].split_whitespace().eq(["0","."]) {
                (ScreenStatus::Invalid,"域名声明不接收邮件（Null MX）")
            } else if records.iter().any(|r|r.split_whitespace().nth(1)==Some(".")) {
                (ScreenStatus::Unknown,"域名收信配置冲突，需复核")
            } else if records.iter().all(|r|{
                let parts=r.split_whitespace().collect::<Vec<_>>();
                parts.len()==2 && parts[0].parse::<u16>().is_ok() && !parts[1].trim_end_matches('.').is_empty()
            }) {(ScreenStatus::Passed,"有邮件接收记录；具体邮箱是否存在仍未验证")}
            else {(ScreenStatus::Unknown,"域名收信记录无法确认")}
        },
        DnsAnswer::Missing=>{
            if [a,aaaa].iter().any(|v|matches!(v,DnsAnswer::Records(r) if !r.is_empty())) {
                (ScreenStatus::Passed,"无MX但存在地址记录（隐式收信路由）；具体邮箱未验证")
            } else if [a,aaaa].iter().all(|v|matches!(v,DnsAnswer::Missing|DnsAnswer::NxDomain)) {
                (ScreenStatus::Invalid,"未找到MX或隐式收信地址记录")
            } else {(ScreenStatus::Unknown,"DNS查询未完成，不判为无效")}
        },
        DnsAnswer::Unknown=>(ScreenStatus::Unknown,"DNS超时或暂不可用，不判为无效"),
    }
}

async fn dns_once(client:&reqwest::Client,endpoint:&str,domain:&str,kind:u64)->DnsAnswer {
    let result=async {
        let response=client.get(endpoint).query(&[("name",domain),("type",&kind.to_string())])
            .header("Accept","application/dns-json").timeout(Duration::from_secs(4)).send().await.ok()?;
        if !response.status().is_success(){return None;}
        let bytes=response.bytes().await.ok()?;
        if bytes.len()>64*1024{return None;}
        let value:Value=serde_json::from_slice(&bytes).ok()?;
        Some(parse_dns(&value,domain,kind))
    }.await;
    result.unwrap_or(DnsAnswer::Unknown)
}
async fn dns(client:&reqwest::Client,domain:&str,kind:u64)->DnsAnswer {
    let first=dns_once(client,"https://cloudflare-dns.com/dns-query",domain,kind).await;
    if matches!(first,DnsAnswer::Records(ref r) if !r.iter().any(|r|r.split_whitespace().nth(1)==Some("."))) {return first;}
    let second=dns_once(client,"https://dns.google/resolve",domain,kind).await;
    // A hard rejection requires consistent independent resolver responses.
    match (&first,&second) {
        (DnsAnswer::NxDomain,DnsAnswer::NxDomain)|(DnsAnswer::Missing,DnsAnswer::Missing)=>first,
        (DnsAnswer::Records(a),DnsAnswer::Records(b)) if a==b=>first,
        (DnsAnswer::Unknown,DnsAnswer::Records(r)) if !r.iter().any(|r|r.split_whitespace().nth(1)==Some("."))=>second,
        _=>DnsAnswer::Unknown,
    }
}

pub async fn prescreen(client:&reqwest::Client,emails:&[String],now:i64)->Vec<EmailScreen> {
    let mut domains=HashMap::new();
    let mut tasks=tokio::task::JoinSet::new();
    let gate=std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    for email in emails {
        let Ok(domain)=address_domain(email) else {continue};
        if domains.insert(domain.clone(),(ScreenStatus::Unknown,"DNS查询未完成")).is_some(){continue;}
        let client=client.clone();let gate=gate.clone();
        tasks.spawn(async move {
            let _permit=gate.acquire().await;
            let mx=dns(&client,&domain,15).await;
            let (a,aaaa)=if matches!(mx,DnsAnswer::Missing) {tokio::join!(dns(&client,&domain,1),dns(&client,&domain,28))}else{(DnsAnswer::Unknown,DnsAnswer::Unknown)};
            (domain,judge_domain(&mx,&a,&aaaa))
        });
    }
    while let Some(joined)=tasks.join_next().await {if let Ok((domain,result))=joined{domains.insert(domain,result);}}
    emails.iter().map(|email|{
        let (status,reason)=match address_domain(email) {
            Ok(domain)=>domains.get(&domain).cloned().unwrap_or((ScreenStatus::Unknown,"DNS查询未完成")),
            Err(ScreenStatus::Unknown)=>(ScreenStatus::Unknown,"特殊邮箱格式需专门验证，不作无效判断"),
            Err(_)=>(ScreenStatus::Invalid,"邮箱格式错误或是遮罩/占位内容，不是完整地址"),
        };
        EmailScreen{email:email.trim().to_ascii_lowercase(),status,reason:reason.into(),checked_at:now}
    }).collect()
}

/// Parses only documented verifier states; never upgrades catch-all or webmail.
pub fn parse_hunter(code:u16,body:&Value,email:&str,now:i64)->Result<EmailVerification,&'static str> {
    if code==202{return Err("Hunter仍在验证，请稍后手动重试；未自动重复调用");}
    if code==401 || code==403{return Err("Hunter认证或权限受限，请检查Key和账户额度");}
    if code==429{return Err("Hunter额度或请求频率已达限制，已停止本批验证");}
    if code==451{return Ok(EmailVerification{email:email.into(),delivery_status:DeliveryStatus::Blocked,verification_provider:"Hunter".into(),checked_at:now,provider_date:None,reason:"邮箱所有人要求停止处理，请勿继续验证或联系".into(),reason_code:"claimed_email".into()});}
    if code!=200{return Err("Hunter未完成验证，请稍后手动重试");}
    let data=&body["data"];
    if !data["email"].as_str().is_some_and(|s|s.eq_ignore_ascii_case(email)) {return Err("Hunter返回的邮箱与请求不符，未采用该结果");}
    let status=data["status"].as_str().ok_or("Hunter未返回有效状态")?;
    if !["valid","invalid","accept_all","disposable","unknown","webmail","blocked"].contains(&status) {return Err("Hunter未返回有效状态，请稍后手动重试");}
    let delivery_status=if data["accept_all"].as_bool()==Some(true) {DeliveryStatus::AcceptAll}
        else if data["disposable"].as_bool()==Some(true) {DeliveryStatus::Disposable}
        else if data["block"].as_bool()==Some(true) {DeliveryStatus::Blocked}
        else {DeliveryStatus::from_provider(status)};
    let reason=delivery_status.label().to_string();
    let provider_date=data.pointer("/verification/date").and_then(Value::as_str).filter(|s|s.len()==10 && s.chars().all(|c|c.is_ascii_digit()||c=='-')).map(str::to_owned);
    Ok(EmailVerification{email:email.into(),delivery_status,verification_provider:"Hunter".into(),checked_at:now,provider_date,reason,reason_code:status.into()})
}

pub async fn verify_hunter(client:&reqwest::Client,key:&str,email:&str,now:i64)->Result<EmailVerification,&'static str> {
    // Header authentication avoids putting secrets in URLs, errors or proxies' query logs.
    let response=client.get("https://api.hunter.io/v2/email-verifier").bearer_auth(key).query(&[("email",email)])
        .timeout(Duration::from_secs(25)).send().await.map_err(|_|"Hunter网络请求失败或超时，未自动重试")?;
    let code=response.status().as_u16();
    let bytes=response.bytes().await.map_err(|_|"Hunter响应读取失败")?;
    if bytes.len()>256*1024{return Err("Hunter返回内容过大，未采用");}
    let value=serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    parse_hunter(code,&value,email,now)
}

#[cfg(test)]mod tests{
    use super::*;use serde_json::json;
    #[test]fn syntax_rejects_placeholders_and_accepts_plus_idn(){
        for e in ["[email protected]","x@@example.org","a..b@example.org","@example.org","a@example.org/path","a@example.org\\path"]{assert_eq!(address_domain(e),Err(ScreenStatus::Invalid),"{e}");}
        assert_eq!(address_domain("Sales+tag@EXAMPLE.ORG").unwrap(),"example.org");
        assert!(address_domain("a@bücher.de").unwrap().starts_with("xn--"));
    }
    #[test]fn exotic_formats_are_unknown_not_invalid(){for e in ["\"a b\"@example.org","\"a@b\"@example.org","用户@example.org","user@[127.0.0.1]","user@intranet"]{assert_eq!(address_domain(e),Err(ScreenStatus::Unknown));}}
    #[test]fn null_mx_is_not_the_same_as_no_mx(){
        let u=DnsAnswer::Unknown;let n=DnsAnswer::Missing;
        assert_eq!(judge_domain(&DnsAnswer::Records(vec!["0 .".into()]),&u,&u).0,ScreenStatus::Invalid);
        assert_eq!(judge_domain(&n,&DnsAnswer::Records(vec!["192.0.2.1".into()]),&n).0,ScreenStatus::Passed);
        assert_eq!(judge_domain(&n,&n,&n).0,ScreenStatus::Invalid);
        assert_eq!(judge_domain(&n,&u,&n).0,ScreenStatus::Unknown);
    }
    #[test]fn mx_does_not_prove_mailbox_or_catchall(){
        let p=judge_domain(&DnsAnswer::Records(vec!["10 mail.example.org.".into()]),&DnsAnswer::Unknown,&DnsAnswer::Unknown);
        assert_eq!(p.0,ScreenStatus::Passed);assert!(p.1.contains("具体邮箱"));
        assert_eq!(judge_domain(&DnsAnswer::Records(vec!["0 .".into(),"10 mail.example.org.".into()]),&DnsAnswer::Unknown,&DnsAnswer::Unknown).0,ScreenStatus::Unknown);
    }
    #[test]fn dns_response_is_bound_to_question_and_cname_owner(){
        let body=json!({"Status":0,"Question":[{"name":"example.org.","type":15}],"Answer":[{"name":"example.org.","type":5,"data":"mail.example.org."},{"name":"mail.example.org.","type":15,"data":"10 mx.example.org."},{"name":"other.org.","type":15,"data":"0 ."}]});
        assert_eq!(parse_dns(&body,"example.org",15),DnsAnswer::Records(vec!["10 mx.example.org.".into()]));
        assert_eq!(parse_dns(&body,"other.org",15),DnsAnswer::Unknown);
        assert_eq!(parse_dns(&json!({"Status":3}),"example.org",15),DnsAnswer::Unknown);
    }
    #[test]fn temporary_dns_failure_is_never_an_invalid_domain(){
        let b=json!({"Status":2,"Question":[{"name":"example.org","type":15}]});
        assert_eq!(parse_dns(&b,"example.org",15),DnsAnswer::Unknown);
        assert_eq!(judge_domain(&DnsAnswer::Unknown,&DnsAnswer::Missing,&DnsAnswer::Missing).0,ScreenStatus::Unknown);
    }
    #[test]fn verifier_never_promotes_catchall_webmail_or_wrong_mailbox(){
        let mut b=json!({"data":{"email":"a@example.org","status":"valid","accept_all":true,"verification":{"date":"2026-10-01"}}});
        assert_eq!(parse_hunter(200,&b,"a@example.org",123).unwrap().delivery_status,DeliveryStatus::AcceptAll);
        assert!(parse_hunter(200,&b,"b@example.org",123).is_err());
        b["data"]["accept_all"]=json!(false);b["data"]["status"]=json!("webmail");
        assert_eq!(parse_hunter(200,&b,"a@example.org",123).unwrap().delivery_status,DeliveryStatus::Unknown);
    }
    #[test]fn errors_and_pending_do_not_replace_valid_result(){for code in [202,222,401,403,429,500]{assert!(parse_hunter(code,&json!({"data":{"status":"valid"}}),"a@example.org",123).is_err());}}
    #[test]fn provider_date_is_not_relabelled_as_today(){let b=json!({"data":{"email":"a@example.org","status":"valid","verification":{"date":"2026-09-01"}}});let r=parse_hunter(200,&b,"a@example.org",999).unwrap();assert_eq!(r.provider_date.as_deref(),Some("2026-09-01"));assert_eq!(r.checked_at,999);}
    #[test]fn claimed_address_is_not_a_pass(){assert_eq!(parse_hunter(451,&Value::Null,"a@example.org",123).unwrap().delivery_status,DeliveryStatus::Blocked);}
    #[test]fn feedback_separates_soft_failure_from_permanent_suppression(){
        for kind in ["unsubscribe","hard_bounce"]{assert!(contact_block(None,None,Some(kind),100).is_some());}
        for kind in ["soft_bounce","replied","cleared"]{assert!(contact_block(None,None,Some(kind),100).is_none());}
        let screen=EmailScreen{email:"a@example.org".into(),status:ScreenStatus::Invalid,reason:"DNS".into(),checked_at:100};
        assert!(contact_block(Some(&screen),None,None,101).is_some());assert!(contact_block(Some(&screen),None,None,1001).is_none());
    }
}
