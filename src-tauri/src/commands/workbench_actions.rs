use crate::state::AppState;
use pebble_core::{Message, PebbleError, Result};
use pebble_store::{Store, workbench_drafts::{WorkbenchDraftItem, WorkbenchDraftReceipt}};
use scraper::{Html, Selector};
use serde::Serialize;
use std::collections::HashSet;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct WorkbenchDraftPreview {
    pub account_id:String, pub source_id:String, pub source_updated_at:i64, pub source_title:String,
    pub items:Vec<WorkbenchDraftItem>, pub warnings:Vec<String>,
}

fn percent_decode(value:&str)->Result<String>{
    let raw=value.as_bytes();let mut bytes=Vec::with_capacity(raw.len());let mut i=0;
    while i<raw.len(){
        if raw[i]==b'%' {
            if i+2>=raw.len(){return Err(PebbleError::Validation("链接包含不完整编码".into()));}
            let hex=std::str::from_utf8(&raw[i+1..i+3]).map_err(|_|PebbleError::Validation("链接编码无效".into()))?;
            bytes.push(u8::from_str_radix(hex,16).map_err(|_|PebbleError::Validation("链接编码无效".into()))?);i+=3;
        } else {bytes.push(raw[i]);i+=1;}
    }
    String::from_utf8(bytes).map_err(|_|PebbleError::Validation("链接不是有效的UTF-8文本".into()))
}

fn addresses(value:&str)->Result<Vec<String>>{
    let mut out=Vec::new();
    for part in value.split([',',';']){
        let part=part.trim();if part.is_empty(){continue;}
        if part.contains(['\r','\n','\0']) || part.parse::<lettre::Address>().is_err(){return Err(PebbleError::Validation("收件人包含无效邮箱或换行符".into()));}
        if !out.iter().any(|old:&String|old.eq_ignore_ascii_case(part)){out.push(part.to_string());}
    }
    Ok(out)
}

fn safe_plain_html(text:&str)->String{
    format!("<div style=\"white-space:pre-wrap\">{}</div>",text.replace('&',"&amp;").replace('<',"&lt;").replace('>',"&gt;").replace('"',"&quot;"))
}

pub(crate) fn validate_item(item:&WorkbenchDraftItem)->Result<()> {
    if item.to.is_empty() || item.subject.contains(['\r','\n','\0']) || item.body_text.contains('\0') || item.body_text.len()>300_000 {
        return Err(PebbleError::Validation("草稿收件人、主题或正文无效".into()));
    }
    for value in item.to.iter().chain(&item.cc).chain(&item.bcc){
        if addresses(value)?.len()!=1 {return Err(PebbleError::Validation("每项收件人必须是一个完整邮箱".into()));}
    }
    Ok(())
}

fn mailto_item(href:&str,index:usize)->Result<Option<WorkbenchDraftItem>>{
    let url=reqwest::Url::parse(href).map_err(|_|PebbleError::Validation("写信链接无效".into()))?;
    if !url.scheme().eq_ignore_ascii_case("mailto"){return Ok(None);}
    let mut item=WorkbenchDraftItem{key:format!("link-{index}"),to:addresses(&percent_decode(url.path())?)?,cc:vec![],bcc:vec![],subject:String::new(),body_text:String::new(),body_html:None};
    let mut content_fields=HashSet::new();
    for (key,value) in url.query_pairs(){
        let key=key.to_ascii_lowercase();
        match key.as_str(){
            "to"=>item.to.extend(addresses(&value)?),"cc"=>item.cc.extend(addresses(&value)?),"bcc"=>item.bcc.extend(addresses(&value)?),
            "subject"|"body"=>{
                if !content_fields.insert(key.clone()){return Err(PebbleError::Validation("写信链接重复指定主题或正文，请核对原文".into()));}
                if key=="subject"{item.subject=value.into_owned();}else{item.body_text=value.into_owned();}
            }
            _=>{},
        }
    }
    // Bare contact links are not additional messages. Never turn 21 letters
    // plus 21 email-address links into 42 drafts.
    if item.body_text.trim().is_empty(){return Ok(None);}
    for list in [&mut item.to,&mut item.cc,&mut item.bcc]{let mut seen=HashSet::new();list.retain(|s|seen.insert(s.to_lowercase()));}
    validate_item(&item)?;
    item.body_html=Some(safe_plain_html(&item.body_text));Ok(Some(item))
}

pub(crate) fn parse_mailto_drafts(message:&Message)->Result<WorkbenchDraftPreview>{
    if message.body_html_raw.len()>10_000_000 {return Err(PebbleError::Validation("来源邮件过大，请拆分后处理".into()));}
    let html=Html::parse_document(&message.body_html_raw);let selector=Selector::parse("a[href]").expect("constant selector");
    let mut items=Vec::new();let mut seen=HashSet::new();let mut invalid=0;let mut bare=0;
    for (index,anchor) in html.select(&selector).enumerate(){
        let href=anchor.value().attr("href").unwrap_or("").trim();
        if !href.get(..7).is_some_and(|s|s.eq_ignore_ascii_case("mailto:")){continue;}
        match mailto_item(href,index){
            Ok(Some(item))=>{let mut canonical=item.clone();canonical.key.clear();let key=serde_json::to_string(&canonical).map_err(|e|PebbleError::Internal(e.to_string()))?;if seen.insert(key){items.push(item);}},
            Ok(None)=>bare+=1,Err(_)=>invalid+=1,
        }
        if items.len()>1000{return Err(PebbleError::Validation("来源包含超过1000份邮件，请分批导入".into()));}
    }
    if items.is_empty(){return Err(PebbleError::Validation("没有找到带收件人和正文的写信链接；普通邮箱链接不能直接变成完整草稿".into()));}
    let mut warnings=vec!["只提取原链接已有内容，不补写事实；链接没有的附件不会自动附上。保存到本机草稿箱，不会发送。".into()];
    if bare>0 {warnings.push(format!("已忽略{bare}个没有正文的普通邮箱链接，避免重复生成。"));}
    if invalid>0 {warnings.push(format!("有{invalid}个写信链接无效，未纳入；请核对原邮件。"));}
    Ok(WorkbenchDraftPreview{account_id:message.account_id.clone(),source_id:message.id.clone(),source_updated_at:message.updated_at,source_title:message.subject.clone(),items,warnings})
}

pub(crate) fn preview_from_store(store:&Store,account:&str,id:&str)->Result<WorkbenchDraftPreview>{
    let message=store.get_message(id)?.ok_or_else(||PebbleError::Validation("来源邮件已不存在".into()))?;
    if message.account_id!=account || message.is_deleted {return Err(PebbleError::Validation("来源邮件不属于当前工作账户或已删除".into()));}
    if message.remote_version.as_deref()==Some("headers-only"){return Err(PebbleError::Validation("邮件正文尚未下载，请先打开原信完成下载".into()));}
    parse_mailto_drafts(&message)
}

#[tauri::command]
pub fn preview_workbench_mailto_drafts(state:State<'_,AppState>,account_id:String,message_id:String)->Result<WorkbenchDraftPreview>{
    preview_from_store(&state.store,&account_id,&message_id)
}

#[tauri::command]
pub fn commit_workbench_drafts(state:State<'_,AppState>,account_id:String,source_id:Option<String>,source_updated_at:Option<i64>,request_id:String,mut items:Vec<WorkbenchDraftItem>,reply_to_message_id:Option<String>,reply_updated_at:Option<i64>)->Result<Vec<WorkbenchDraftReceipt>>{
    if reply_to_message_id.is_some()!=reply_updated_at.is_some() || (source_id.is_some() && reply_to_message_id.is_some()) {return Err(PebbleError::Validation("回复来源或版本参数不完整".into()));}
    let source_message=source_id.as_ref().map(|id|state.store.get_message(id)).transpose()?.flatten();
    if source_id.is_some() && source_message.is_none(){return Err(PebbleError::Validation("来源邮件已不存在".into()));}
    let source=if let Some(ref message)=source_message {
        if message.account_id!=account_id || message.is_deleted{return Err(PebbleError::Validation("来源不属于当前工作账户".into()));}
        let current=parse_mailto_drafts(message)?;
        if Some(current.source_updated_at)!=source_updated_at{return Err(PebbleError::Validation("来源邮件已变化，请重新预览后确认".into()));}
        for item in &items {
            if !current.items.iter().any(|candidate|candidate==item){return Err(PebbleError::Validation("选择内容与原写信链接不一致，请重新预览；如需修改，请先保存再编辑草稿".into()));}
        }
        Some((message.id.as_str(),current.source_updated_at,message.body_html_raw.as_str()))
    }else{
        for item in &mut items {
            validate_item(item)?;
            item.body_html=Some(safe_plain_html(&item.body_text));
        }
        None
    };
    let result=if let (Some(id),Some(version))=(reply_to_message_id.as_deref(),reply_updated_at) {
        state.store.commit_workbench_reply_draft(&account_id,id,version,&request_id,&items)?
    }else{state.store.commit_workbench_drafts(&account_id,source,&request_id,&items)?};
    let ids=result.iter().filter(|r|r.exists).map(|r|r.draft_id.clone()).collect::<Vec<_>>();
    if let Err(error)=super::messages::refresh_search_documents(&state,&ids){tracing::warn!("Workbench drafts saved; search refresh pending: {error}");}
    Ok(result)
}

#[cfg(test)] mod tests {
    use super::*;
    fn message(html:&str)->Message{serde_json::from_value(serde_json::json!({"id":"fixture","account_id":"one","remote_id":"123","message_id_header":null,"in_reply_to":null,"references_header":null,"thread_id":null,"subject":"Fixture","snippet":"","from_address":"sender@example.test","from_name":"Fixture","to_list":[],"cc_list":[],"bcc_list":[],"body_text":"","body_html_raw":html,"has_attachments":false,"is_read":true,"is_starred":false,"is_draft":false,"date":1,"remote_version":null,"is_deleted":false,"deleted_at":null,"created_at":1,"updated_at":1})).unwrap()}
    #[test]fn extracts_original_fields_and_ignores_bare_links_duplicates_and_scripts(){
        let m=message(r#"<a href="mailto:buyer%2Btag@example.test?subject=Original%20subject&amp;body=Line%201%0ALine%202&amp;cc=copy@example.test&amp;bcc=private@example.test">Write</a><a href="mailto:buyer@example.test">Contact</a><script>doAnything()</script><a href="mailto:buyer%2Btag@example.test?subject=Original%20subject&amp;body=Line%201%0ALine%202&amp;cc=copy@example.test&amp;bcc=private@example.test">Again</a>"#);
        let p=parse_mailto_drafts(&m).unwrap();assert_eq!(p.items.len(),1);let row=&p.items[0];assert_eq!(row.to,["buyer+tag@example.test"]);assert_eq!(row.subject,"Original subject");assert_eq!(row.body_text,"Line 1\nLine 2");assert_eq!(row.cc,["copy@example.test"]);assert_eq!(row.bcc,["private@example.test"]);assert!(!row.body_html.as_ref().unwrap().contains("script"));
    }
    #[test]fn parses_all_links_beyond_two_thousand_characters(){
        let mut html="<p>padding</p>".repeat(1000);for i in 0..92{html.push_str(&format!("<a href=\"mailto:buyer{i}@example.test?subject=Fixture&amp;body=Original%20body%20{i}\">Write</a>"));}
        assert_eq!(parse_mailto_drafts(&message(&html)).unwrap().items.len(),92);
    }
    #[test]fn rejects_header_injection_and_empty_or_untrusted_links(){
        let m=message(r#"<a href="mailto:buyer@example.test?subject=hello%0D%0ABcc%3Aevil&amp;body=Body">Bad</a><a href="javascript:alert(1)">Bad</a><a href="mailto:buyer@example.test">Bare</a>"#);assert!(parse_mailto_drafts(&m).is_err());
    }
}
