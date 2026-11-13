//! Main-content extraction for research pages.
//!
//! Company homepages mix navigation menus, cookie banners and repeated product
//! teasers into the body text. Because the review model only ever receives a
//! fixed prefix of each page, that boilerplate used to fill the evidence window
//! before the sentence describing what the company actually does. Reducing a
//! page to its article body first makes the same character budget carry business
//! facts instead of menu labels.
//!
//! This lives outside the desktop shell so the extraction rules can be tested on
//! their own, without a Tauri runtime, and so any caller that reads a page uses
//! the same rules.

use dom_smoothie::{Config, Readability, TextMode};

/// Upper bound kept for one page body. The model only sees a prefix of this, so
/// the limit is a memory guard, not the evidence budget.
pub const MAX_PAGE_TEXT: usize = 120_000;
/// Footer tail kept after extraction. The registered company name, postal
/// address, VAT number and legal notice live in the footer, and exactly those
/// facts are used to verify location.
const PAGE_FOOTER_WINDOW: usize = 1_200;
/// Below this the "main content" is not an article: a JS-only shell, a tag
/// index or a 404. Falling back to the full body is safer than handing the
/// caller an almost empty page.
const MIN_MAIN_CONTENT_CHARS: usize = 400;

fn compact(value: &str, max_chars: usize) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max_chars).collect()
}

/// Readability extraction of the article body. Returns `None` when the page has
/// no usable article body (homepage, index, 404, script shell).
pub fn readability_text(html: &str, url: &str) -> Option<String> {
    let config = Config { text_mode: TextMode::Formatted, ..Default::default() };
    let mut reader = Readability::new(html, Some(url), Some(config)).ok()?;
    let article = reader.parse().ok()?;
    let text = compact(article.text_content.as_ref(), MAX_PAGE_TEXT);
    (!text.trim().is_empty()).then_some(text)
}

/// Main content first, then the part of the footer that is not already in the
/// body. When the extracted body already covers nearly the whole page there is
/// nothing to add.
pub fn compose_page_text(main: Option<String>, full: &str) -> String {
    let full = full.trim();
    let Some(main) = main.map(|value| value.trim().to_string()).filter(|value| value.chars().count() >= MIN_MAIN_CONTENT_CHARS) else {
        return full.to_string();
    };
    let chars: Vec<char> = full.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(PAGE_FOOTER_WINDOW)..].iter().collect();
    let fresh = footer_supplement(&main, tail.trim());
    if fresh.is_empty() { main } else { format!("{main}\n{fresh}") }
}

/// Footer text that is not already part of the extracted body. The window starts
/// inside the article more often than not, so the overlap is skipped in slices
/// rather than discarding the whole tail, which is where the address lives.
fn footer_supplement(main: &str, tail: &str) -> String {
    const WINDOW: usize = 40;
    let chars: Vec<char> = tail.chars().collect();
    if chars.len() <= WINDOW {
        return if main.contains(tail) { String::new() } else { tail.to_string() };
    }
    let mut cut = 0usize;
    while cut + WINDOW < chars.len() {
        let window: String = chars[cut..cut + WINDOW].iter().collect();
        if !main.contains(&window) { break; }
        cut += WINDOW / 2;
    }
    if cut + WINDOW >= chars.len() { return String::new(); }
    chars[cut..].iter().collect::<String>().trim().to_string()
}

/// Text handed to the model for one fetched page: extracted article body plus a
/// footer window, or the full visible body when no article could be extracted.
pub fn main_content_text(html: &str, url: &str, full_text: &str) -> String {
    compose_page_text(readability_text(html, url), full_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn menus(count: usize) -> String {
        (0..count).map(|i| format!("<li><a href='/p{i}'>Wholesale catalogue category {i}</a></li>")).collect()
    }
    fn paragraphs(count: usize) -> String {
        (0..count).map(|_| "<p>Acme Botanical is an independent gift wholesaler serving florist shops across Europe with preserved flower collections and botanical gift sets for retail partners.</p>").collect()
    }

    #[test] fn business_description_survives_a_menu_heavy_homepage() {
        let html = format!("<html><body><nav><ul>{}</ul></nav><article>{}</article><footer>Acme Botanical GmbH, Hauptstrasse 12, 10115 Berlin, VAT DE123456789</footer></body></html>", menus(40), paragraphs(8));
        let text = main_content_text(&html, "https://acme.example/about", &full_body(&html));
        let at = text.find("independent gift wholesaler").expect("business description must survive extraction");
        assert!(at < 600, "description must not be pushed behind menus, was at {at}");
        assert!(text.contains("Hauptstrasse 12"), "footer address must still reach the model");
    }

    #[test] fn a_page_without_an_article_keeps_its_full_body_text() {
        let html = format!("<html><body><div>{}</div><main><p>Acme supplies botanical gifts.</p></main><footer>Acme Botanical GmbH, Hauptstrasse 12, Berlin</footer></body></html>", menus(30));
        let text = main_content_text(&html, "https://acme.example/", &full_body(&html));
        assert!(text.contains("Acme supplies botanical gifts"));
        assert!(text.contains("Hauptstrasse 12"));
    }

    #[test] fn the_footer_window_is_added_once_and_never_duplicated() {
        let body = "Acme makes botanical gifts for florists. ".repeat(40);
        assert_eq!(compose_page_text(Some(body.clone()), &body), body.trim());
        let main = "Acme makes botanical gifts for florists ".repeat(20);
        let full = format!("{}{}", "menu ".repeat(1200), "Acme Botanical GmbH, Hauptstrasse 12, Berlin, VAT DE123456789");
        let text = compose_page_text(Some(main.clone()), &full);
        assert!(text.starts_with(main.trim()));
        assert_eq!(text.matches("Hauptstrasse 12").count(), 1);
    }

    #[test] fn a_short_or_missing_body_falls_back_instead_of_returning_nothing() {
        assert_eq!(compose_page_text(None, "  Contact our company  "), "Contact our company");
        assert_eq!(compose_page_text(Some("tiny".into()), "Contact our company"), "Contact our company");
        assert_ne!(readability_text("<html></html>", "https://acme.example/").as_deref(), Some(""));
    }

    #[test] fn short_legal_footer_is_not_dropped_when_the_article_is_most_of_the_page(){
        let main="Acme supplies industrial lighting. ".repeat(220);
        let full=format!("{main} Registered office: 12 Sample Road, Germany. VAT DE123456789.");
        let text=compose_page_text(Some(main),&full);
        assert!(text.contains("Sample Road"));assert_eq!(text.matches("VAT DE123456789").count(),1);
    }

    /// Visible body text, the same fallback the shell crate feeds in: tags
    /// stripped, whitespace compacted. Real visibility filtering (scripts,
    /// hidden nodes) lives in the shell crate and is tested there.
    fn full_body(html: &str) -> String {
        let stripped = ["<script", "</script>", "<style", "</style>"].iter().fold(html.to_string(), |acc, marker| acc.replace(marker, " "));
        let mut text = String::new();
        for chunk in stripped.split('<') {
            if let Some(end) = chunk.find('>') { text.push_str(&chunk[end + 1..]); }
        }
        text.split_whitespace().collect::<Vec<_>>().join(" ")
    }
}
