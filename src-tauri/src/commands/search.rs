use crate::state::AppState;
use pebble_core::traits::SearchHit;
use pebble_core::PebbleError;
use pebble_store::Store;
use tauri::State;

/// Older Tantivy documents may not contain folder_ids. Fill only those hits
/// from the authoritative local relation table so search results always show
/// their real source folder without rebuilding or downloading mail.
pub(crate) fn hydrate_folder_ids(
    store: &Store,
    mut hits: Vec<SearchHit>,
) -> std::result::Result<Vec<SearchHit>, PebbleError> {
    let missing_ids: Vec<String> = hits
        .iter()
        .filter(|hit| hit.folder_ids.is_empty())
        .map(|hit| hit.message_id.clone())
        .collect();
    if missing_ids.is_empty() {
        return Ok(hits);
    }
    let folder_map = store.get_message_folder_ids_batch(&missing_ids)?;
    for hit in &mut hits {
        if hit.folder_ids.is_empty() {
            hit.folder_ids = folder_map.get(&hit.message_id).cloned().unwrap_or_default();
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn search_messages(
    state: State<'_, AppState>,
    query: String,
    limit: Option<usize>,
    account_id: Option<String>,
) -> std::result::Result<Vec<SearchHit>, PebbleError> {
    let limit = limit.unwrap_or(50);
    let search = state.search.clone();
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        let hits = if account_id.as_deref().is_some_and(|id| !id.is_empty()) {
            search.advanced_search(pebble_search::AdvancedSearchParams {
                text: Some(&query),
                from: None,
                to: None,
                subject: None,
                date_from: None,
                date_to: None,
                has_attachment: None,
                account_id: account_id.as_deref(),
                folder_id: None,
                limit,
            })
        } else {
            search.search(&query, limit)
        }?;
        hydrate_folder_ids(&store, hits)
    })
        .await
        .map_err(|e| PebbleError::Internal(format!("Task join error: {e}")))?
}
