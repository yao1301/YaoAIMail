//! Conservative feedback classification. No model, network, mailbox mutation or
//! inference from quoted messages. Callers supply actual sent-message evidence.
use serde::{Deserialize,Serialize};
#[derive(Clone,Debug,Serialize,Deserialize,PartialEq,Eq)]
pub struct FeedbackSignal {pub email:String,pub kind:String,pub sent_header:String,pub reason:String}
#[derive(Clone,Debug)]
pub struct SentEvidence {pub header:String,pub recipients:Vec<String>}
pub fn message_ids(text:&str)->Vec<String>{
    text.split_whitespace().map(|s|s.trim_matches(|c|matches!(c,'<'|'>'|','|';')).to_string())
        .filter(|s|s.len()<500 && s.contains('@') && !s.contains(['\r','\n'])).take(32).collect()
}
fn direct_text(body:&str)->String {
    let mut lines=vec![];
    for line in body.lines().take(80){let clean=line.trim();let lower=clean.to_lowercase();
        if clean.starts_with('>') || lower.starts_with("from:") || lower.starts_with("发件人:") || lower.starts_with("发件人：")
            || lower.contains("original message") || lower.contains("forwarded message") || lower.contains("回复的原邮件")
            || (lower.starts_with("on ") && lower.ends_with("wrote:")){break}
        lines.push(clean);if lines.join("\n").len()>4000{break}
    }lines.join("\n")
}
fn opt_out(text:&str)->Option<String>{
    for (index,line) in text.lines().filter(|l|!l.trim().is_empty()).take(4).enumerate(){let clean=line.trim().trim_end_matches(['.','!','。','！']).to_lowercase();
        let clean=clean.strip_prefix("please ").unwrap_or(&clean).trim();
        if index>0 && matches!(clean,"unsubscribe"|"退订"){continue}
        // Whole direct statements only: a signature footer, negation, example
        // or mention of unsubscribe must never become an opt-out.
        if ["unsubscribe","remove me from your list","remove us from your list","stop emailing me","stop emailing us","do not email me again","do not contact me again","do not contact us again","please unsubscribe me","unsubscribe me","unsubscribe us","不要再给我发邮件","请不要再给我发邮件","请将我移出邮件列表","退订"].contains(&clean){return Some(line.trim().chars().take(220).collect())}
    }None
}
fn field(text:&str,name:&str)->Option<String>{text.lines().find_map(|l|{let(k,v)=l.trim().split_once(':')?;k.eq_ignore_ascii_case(name).then(||v.trim().to_string())})}
pub fn infer(from:&str,reply_ids:&str,body:&str,delivery_report:&str,sent:&[SentEvidence])->Vec<FeedbackSignal>{
    let sender=from.trim().to_ascii_lowercase();let direct=direct_text(body);let refs=message_ids(reply_ids);
    let mut signals=vec![];
    for original in sent {
        let header=original.header.trim_matches(['<','>']);
        let recipients=original.recipients.iter().map(|s|s.trim().to_ascii_lowercase()).collect::<Vec<_>>();
        if refs.iter().any(|id|id==header) && recipients.contains(&sender) && !direct.trim().is_empty() {
            let reply=opt_out(&direct);
            let automatic=["automatic reply","auto-reply","out of office","away from the office","自动回复","不在办公室"].iter().any(|s|direct.to_lowercase().contains(s));
            if reply.is_some() || !automatic {signals.push(FeedbackSignal{email:sender.clone(),kind:if reply.is_some(){"unsubscribe"}else{"replied"}.into(),sent_header:original.header.clone(),reason:reply.unwrap_or_else(||"本账户实际已发送邮件的关联回复；不等于成交或有效购买意向".into())});}
        }
        // A DSN must identify an actual original message and the exact original
        // recipient. SMTP 250 or a random address in prose is not delivery proof.
        let local=sender.split('@').next().unwrap_or("");
        if !["mailer-daemon","postmaster"].contains(&local){continue}
        let report=delivery_report.replace("\r\n","\n");
        let report_id=field(&report,"Original-Message-ID").or_else(||field(&report,"Message-ID"));
        let correlated=refs.iter().any(|id|id==header) || report_id.as_deref().is_some_and(|s|message_ids(s).iter().any(|id|id==header));
        if !correlated {continue}
        for block in report.split("\n\n") {
            let recipient=field(block,"Final-Recipient").and_then(|r|r.split_once(';').map(|(_,s)|s.trim().to_ascii_lowercase()));
            let Some(email)=recipient.filter(|r|recipients.contains(r)) else{continue};
            let action=field(block,"Action").unwrap_or_default().to_lowercase();let status=field(block,"Status").unwrap_or_default();
            let kind=if action=="failed" && ["5.1.1","5.1.2","5.1.3","5.1.6"].contains(&status.as_str()) {"hard_bounce"}
                else if (action=="delayed" && status.starts_with("4.")) || (action=="failed" && status=="5.2.2"){"soft_bounce"}else{continue};
            signals.push(FeedbackSignal{email,kind:kind.into(),sent_header:original.header.clone(),reason:format!("关联原已发送邮件的DSN：Action={action}; Status={status}；不以服务器接受当作送达")});
        }
    }
    signals.sort_by(|a,b|(&a.email,&a.kind).cmp(&(&b.email,&b.kind)));signals.dedup_by(|a,b|a.email==b.email&&a.kind==b.kind);signals
}
#[cfg(test)]mod tests{
 use super::*;fn sent()->Vec<SentEvidence>{vec![SentEvidence{header:"<out@sender.invalid>".into(),recipients:vec!["buyer@example.invalid".into()]}]}
 #[test]fn reply_requires_exact_sender_recipient_and_original_reference(){assert_eq!(infer("buyer@example.invalid","<out@sender.invalid>","Please send a quotation.","",&sent())[0].kind,"replied");assert!(infer("other@example.invalid","out@sender.invalid","Thanks","",&sent()).is_empty());assert!(infer("buyer@example.invalid","unknown@sender.invalid","Thanks","",&sent()).is_empty());}
 #[test]fn optout_uses_direct_whole_statement_not_quoted_footer_or_negation(){for body in ["Do not unsubscribe me.","How does unsubscribe work?","Thanks\n> Please remove me from your list","Thanks\nFrom: previous sender\nUnsubscribe","Thanks for your quotation.\nBest regards\nUnsubscribe"]{assert!(infer("buyer@example.invalid","out@sender.invalid",body,"",&sent()).iter().all(|s|s.kind!="unsubscribe"),"{body}");}assert_eq!(infer("buyer@example.invalid","out@sender.invalid","Please remove me from your list.","",&sent())[0].kind,"unsubscribe");}
 #[test]fn autoreply_is_not_a_human_response(){assert!(infer("buyer@example.invalid","out@sender.invalid","Automatic reply: I am out of office.","",&sent()).is_empty());}
 #[test]fn dsn_checks_original_recipient_action_and_status_together(){let report="Original-Message-ID: <out@sender.invalid>\n\nFinal-Recipient: rfc822; buyer@example.invalid\nAction: failed\nStatus: 5.1.1";assert_eq!(infer("mailer-daemon@example.invalid","","",report,&sent())[0].kind,"hard_bounce");assert!(infer("mailer-daemon@example.invalid","","",&report.replace("5.1.1","5.7.1"),&sent()).is_empty());assert!(infer("mailer-daemon@example.invalid","","",&report.replace("buyer@example.invalid","other@example.invalid"),&sent()).is_empty());assert!(infer("buyer@example.invalid","","",report,&sent()).is_empty());}
 #[test]fn temporary_mailbox_full_and_smtp_acceptance_do_not_validate_delivery(){let report="Original-Message-ID: <out@sender.invalid>\n\nFinal-Recipient: rfc822; buyer@example.invalid\nAction: delayed\nStatus: 4.2.2";assert_eq!(infer("postmaster@example.invalid","","",report,&sent())[0].kind,"soft_bounce");assert!(infer("postmaster@example.invalid","","",&report.replace("delayed","delivered").replace("4.2.2","2.0.0"),&sent()).is_empty());}
}
