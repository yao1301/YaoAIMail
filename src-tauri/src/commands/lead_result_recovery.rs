//! Reconcile durable native deliveries after the originating WebView unmounts.
//! Never create tasks, cross accounts, overwrite contacts or resurrect a deleted task.
use serde_json::{json, Value};

pub fn reconcile(data: &mut Value, memos: &Value) {
    let Some(sessions) = data["searchSessions"].as_array_mut() else { return };
    for session in sessions {
        let Some(id)=session["id"].as_str().filter(|id|!id.is_empty()) else{continue};
        let Some(memo) = memos.as_array().and_then(|all| all.iter().find(|m|
            m["id"].as_str() == Some(id) && m["scope"].as_str().unwrap_or("") == session["accountId"].as_str().unwrap_or(""))) else { continue };
        let round = memo["round"].as_u64().unwrap_or(0);
        let delivered = session["nativeResultRound"].as_u64().unwrap_or_else(|| {
            // Legacy nonempty completed pages may include manual deletions.
            if session["results"].as_array().is_some_and(|r| !r.is_empty()) { session["page"].as_u64().unwrap_or(0) } else { 0 }
        });
        if round == 0 || round <= delivered { continue }
        let Some(items) = memo["last"]["items"].as_array() else { continue };
        let mut results = session["results"].as_array().cloned().unwrap_or_default();
        for item in items {
            let c = &item["company"];
            if results.iter().any(|old| old["website"] == c["website"]) { continue }
            results.push(json!({"companyName":c["legalName"],"website":c["website"],"sourceUrl":c["sourceUrl"],
                "country":c["country"],"city":c["city"],"address":c["address"],"description":c["description"],
                "reason":c["recommendationReason"],"recommendationReason":c["recommendationReason"],
                "companyIntroduction":c["companyIntroduction"],"discoveryBasis":c["discoveryBasis"],
                "websiteStatus":c["websiteStatus"],"websiteStatusReason":c["websiteStatusReason"],
                "source":c["sourceName"],"quality":item["quality"],"emails":c["publicEmails"],
                "emailEvidence":c["emailEvidence"],"contacts":c["contacts"],"buyingSignals":c["buyingSignals"],
                "contactStatus":c["contactStatus"],"emailDiscoveryStatus":"pending"}));
        }
        session["resultCount"] = json!(results.len());
        session["results"] = json!(results);
        session["page"] = json!(round);
        session["nativeResultRound"] = json!(round);
        session["discoveryReport"] = memo["last"]["report"].clone();
        if let Some(o) = session.as_object_mut() { o.remove("failure"); o.remove("failureDetail"); }
    }
}

/// Contact tasks can finish while no finder component exists. Reuse their
/// already-completed public findings; never spend another search/Hunter credit.
pub fn restore_contacts(data:&mut Value,jobs:&Value) {
    let Some(sessions)=data["searchSessions"].as_array_mut() else{return};
    for session in sessions {
        let created=session["createdAt"].as_i64().unwrap_or(i64::MAX);
        let Some(results)=session["results"].as_array_mut() else{continue};
        for row in results {
            if row["emailDiscoveryStatus"]=="completed" {continue;}
            let Some(host)=row["website"].as_str().and_then(pebble_websearch::leads::host) else{continue};
            let completed=jobs.as_array().into_iter().flatten().filter(|job|
                job["status"]=="succeeded" && job["request"]["kind"]=="contacts"
                && job["created_at"].as_i64().is_some_and(|t|t>=created)
                && job["request"]["input"]["website"].as_str().and_then(pebble_websearch::leads::host)==Some(host.clone())
                && job["result"]["website"].as_str().and_then(pebble_websearch::leads::host)==Some(host.clone()))
                .max_by_key(|job|job["updated_at"].as_i64().unwrap_or(0));
            let Some(job)=completed else{continue};
            let company=&job["result"];
            // Existing enriched or manually edited data wins. A restored row's
            // empty fields can be filled from the same-domain completed task.
            for (field,native) in [("emails","publicEmails"),("emailEvidence","emailEvidence"),("contacts","contacts"),("buyingSignals","buyingSignals")] {
                if row[field].is_null() || row[field].as_array().is_some_and(Vec::is_empty) {
                    if company[native].is_array(){row[field]=company[native].clone();}
                }
            }
            if row["emailDiscoveryStatus"]!="completed" && row["emails"].as_array().is_some_and(|v|!v.is_empty()) {
                row["emailDiscoveryStatus"]=json!("completed");row["contactStatus"]=json!("可联系");
            }
        }
    }
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn restores_zero_frontend_from_completed_native_delivery_without_network() {
        let mut data=json!({"searchSessions":[{"id":"task","accountId":"a","page":0,"results":[],"resultCount":0}],"savedLeads":[]});
        let memos=json!([{"id":"task","scope":"a","round":1,"last":{"items":[{"company":{"legalName":"Example","website":"https://example.invalid","country":"Example country"},"quality":{"level":"needs_review"}}],"report":{"pageSize":20}}}]);
        reconcile(&mut data,&memos);assert_eq!(data["searchSessions"][0]["resultCount"],1);
        assert_eq!(data["searchSessions"][0]["results"][0]["country"],"Example country");
        // Same delivery is applied once, so subsequent manual removals stay removed.
        data["searchSessions"][0]["results"]=json!([]);reconcile(&mut data,&memos);
        assert_eq!(data["searchSessions"][0]["results"],json!([]));
        data["searchSessions"][0]["accountId"]=json!("other");data["searchSessions"][0]["nativeResultRound"]=json!(0);
        reconcile(&mut data,&memos);assert_eq!(data["searchSessions"][0]["results"],json!([]));
        data["searchSessions"]=json!([]);reconcile(&mut data,&memos);assert_eq!(data["searchSessions"],json!([]));
    }
    #[test] fn partial_delivery_keeps_enriched_contacts_when_the_final_native_page_is_recovered() {
        let mut data=json!({"searchSessions":[{"id":"task","accountId":"a","nativeResultRound":0,"page":1,"results":[{"companyName":"First","website":"https://first.invalid","emails":["contact@first.invalid"]}]}]});
        let memos=json!([{"id":"task","scope":"a","round":1,"last":{"items":[{"company":{"website":"https://first.invalid","publicEmails":[]}}, {"company":{"legalName":"Second","website":"https://second.invalid"}}],"report":{}}}]);
        reconcile(&mut data,&memos);
        assert_eq!(data["searchSessions"][0]["resultCount"],2);
        assert_eq!(data["searchSessions"][0]["results"][0]["emails"][0],"contact@first.invalid");
        assert_eq!(data["searchSessions"][0]["nativeResultRound"],1);
    }
    #[test] fn completed_contact_recovery_requires_matching_company_and_task_age_and_preserves_edits() {
        let mut data=json!({"searchSessions":[{"createdAt":100,"results":[{"website":"https://example.invalid/","emails":[]},{"website":"https://other.invalid","emails":[]}]}]});
        let job=json!({"status":"succeeded","created_at":101,"updated_at":102,"request":{"kind":"contacts","input":{"website":"https://example.invalid"}},"result":{"website":"https://example.invalid","publicEmails":["contact@example.invalid"],"emailEvidence":[]}});
        restore_contacts(&mut data,&json!([job.clone()]));
        assert_eq!(data["searchSessions"][0]["results"][0]["emails"][0],"contact@example.invalid");
        assert_eq!(data["searchSessions"][0]["results"][1]["emails"],json!([]));
        data["searchSessions"][0]["results"][0]["emails"]=json!(["edited@example.invalid"]);
        restore_contacts(&mut data,&json!([job.clone()]));assert_eq!(data["searchSessions"][0]["results"][0]["emails"][0],"edited@example.invalid");
        data["searchSessions"][0]["results"][0]["emails"]=json!([]);data["searchSessions"][0]["createdAt"]=json!(103);
        restore_contacts(&mut data,&json!([job]));assert_eq!(data["searchSessions"][0]["results"][0]["emails"],json!([]));
    }
}
