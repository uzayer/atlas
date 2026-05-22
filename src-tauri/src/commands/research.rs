use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct ArxivPaper {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub summary: String,
    pub published: String,
    pub pdf_url: String,
    pub link: String,
    pub categories: Vec<String>,
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default()
}

#[tauri::command]
pub async fn search_arxiv(query: String, max_results: Option<u32>) -> Result<Vec<ArxivPaper>, String> {
    let max = max_results.unwrap_or(10);
    let url = format!(
        "https://export.arxiv.org/api/query?search_query=all:{}&start=0&max_results={}",
        urlencoded(&query),
        max
    );

    let xml = http_client()
        .get(&url)
        .send().await
        .map_err(|e| format!("Failed to fetch arXiv: {}", e))?
        .text().await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    Ok(parse_arxiv_xml(&xml))
}

fn urlencoded(s: &str) -> String {
    s.replace(' ', "+")
        .replace('&', "%26")
        .replace('=', "%3D")
        .replace('?', "%3F")
}

fn parse_arxiv_xml(xml: &str) -> Vec<ArxivPaper> {
    let mut papers = Vec::new();

    for entry in xml.split("<entry>").skip(1) {
        let end = entry.find("</entry>").unwrap_or(entry.len());
        let entry = &entry[..end];

        let id = extract_tag(entry, "id").unwrap_or_default();
        let title = extract_tag(entry, "title")
            .unwrap_or_default()
            .replace('\n', " ")
            .trim()
            .to_string();
        let summary = extract_tag(entry, "summary")
            .unwrap_or_default()
            .replace('\n', " ")
            .trim()
            .to_string();
        let published = extract_tag(entry, "published").unwrap_or_default();

        let authors: Vec<String> = entry
            .split("<author>")
            .skip(1)
            .filter_map(|a| extract_tag(a, "name"))
            .collect();

        let pdf_url = entry
            .split("<link")
            .find(|l| l.contains("title=\"pdf\""))
            .and_then(|l| {
                l.split("href=\"").nth(1).and_then(|h| {
                    h.split('"').next().map(|s| s.to_string())
                })
            })
            .unwrap_or_default();

        let categories: Vec<String> = entry
            .split("<category")
            .skip(1)
            .filter_map(|c| {
                c.split("term=\"").nth(1).and_then(|t| {
                    t.split('"').next().map(|s| s.to_string())
                })
            })
            .collect();

        if !title.is_empty() {
            papers.push(ArxivPaper {
                id: id.split('/').last().unwrap_or(&id).to_string(),
                title,
                authors,
                summary,
                published: published.chars().take(10).collect(),
                pdf_url,
                link: id,
                categories,
            });
        }
    }

    papers
}

#[tauri::command]
pub async fn search_semantic_scholar(
    query: String,
    max_results: Option<u32>,
) -> Result<Vec<ArxivPaper>, String> {
    let max = max_results.unwrap_or(10);
    let url = format!(
        "https://api.semanticscholar.org/graph/v1/paper/search?query={}&limit={}&fields=title,authors,abstract,year,externalIds,url,openAccessPdf,fieldsOfStudy",
        urlencoded(&query),
        max
    );

    let text = http_client()
        .get(&url)
        .send().await
        .map_err(|e| format!("Failed to fetch Semantic Scholar: {}", e))?
        .text().await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Parse error: {}", e))?;

    let mut papers = Vec::new();

    if let Some(data) = v.get("data").and_then(|d| d.as_array()) {
        for item in data {
            let title = item.get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();

            if title.is_empty() {
                continue;
            }

            let authors: Vec<String> = item.get("authors")
                .and_then(|a| a.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                        .map(|s| s.to_string())
                        .collect()
                })
                .unwrap_or_default();

            let summary = item.get("abstract")
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_string();

            let year = item.get("year")
                .and_then(|y| y.as_u64())
                .map(|y| y.to_string())
                .unwrap_or_default();

            let paper_id = item.get("paperId")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();

            let link = item.get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();

            let pdf_url = item.get("openAccessPdf")
                .and_then(|o| o.get("url"))
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();

            let categories: Vec<String> = item.get("fieldsOfStudy")
                .and_then(|f| f.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|f| f.as_str())
                        .map(|s| s.to_string())
                        .collect()
                })
                .unwrap_or_default();

            let arxiv_id = item.get("externalIds")
                .and_then(|e| e.get("ArXiv"))
                .and_then(|a| a.as_str())
                .unwrap_or(&paper_id)
                .to_string();

            papers.push(ArxivPaper {
                id: arxiv_id,
                title,
                authors,
                summary,
                published: year,
                pdf_url,
                link,
                categories,
            });
        }
    }

    Ok(papers)
}

#[tauri::command]
pub async fn download_paper(
    pdf_url: String,
    project_path: String,
    paper_id: String,
    paper_title: String,
) -> Result<String, String> {
    let papers_dir = Path::new(&project_path).join(".atlas").join("papers");
    fs::create_dir_all(&papers_dir).map_err(|e| e.to_string())?;

    let filename = format!("{}.pdf", paper_id.replace('/', "_"));
    let dest = papers_dir.join(&filename);

    // Async download with 30s timeout for large files
    let bytes = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default()
        .get(&pdf_url)
        .send().await
        .map_err(|e| format!("Download failed: {}", e))?
        .bytes().await
        .map_err(|e| format!("Failed to read PDF: {}", e))?;

    // Write file in blocking context
    let dest_clone = dest.clone();
    tokio::task::spawn_blocking(move || {
        fs::write(&dest_clone, &bytes)
    }).await
        .map_err(|e| format!("Join error: {}", e))?
        .map_err(|e| format!("Write failed: {}", e))?;

    // Save metadata
    let meta_path = papers_dir.join(format!("{}.json", paper_id.replace('/', "_")));
    let meta = serde_json::json!({
        "id": paper_id,
        "title": paper_title,
        "pdf_url": pdf_url,
        "local_path": dest.to_string_lossy(),
        "downloaded_at": chrono::Utc::now().to_rfc3339(),
    });
    tokio::task::spawn_blocking(move || {
        fs::write(&meta_path, serde_json::to_string_pretty(&meta).unwrap())
    }).await
        .map_err(|e| format!("Join error: {}", e))?
        .map_err(|e| format!("Meta write failed: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_paper_to_knowledge(
    project_path: String,
    paper_id: String,
    title: String,
    authors: Vec<String>,
    summary: String,
    link: String,
    categories: Vec<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let kb_dir = Path::new(&project_path).join(".atlas").join("knowledge");
        fs::create_dir_all(&kb_dir).map_err(|e| e.to_string())?;

        let filename = format!("paper-{}.md", paper_id.replace('/', "_"));
        let filepath = kb_dir.join(&filename);

        let content = format!(
            "# {}\n\n**Authors:** {}\n\n**Categories:** {}\n\n**arXiv:** [{}]({})\n\n## Abstract\n\n{}\n\n---\n*Saved from Atlas Research*\n",
            title,
            authors.join(", "),
            categories.join(", "),
            paper_id,
            link,
            summary,
        );

        fs::write(&filepath, &content).map_err(|e| e.to_string())?;
        Ok(filepath.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetch trending papers — runs all 3 category queries CONCURRENTLY
#[tauri::command]
pub async fn fetch_trending_papers() -> Result<Vec<ArxivPaper>, String> {
    let queries = ["cat:cs.AI", "cat:cs.LG", "cat:math.OC"];
    let client = http_client();

    // Fire all 3 requests concurrently
    let futures: Vec<_> = queries.iter().map(|q| {
        let url = format!(
            "https://export.arxiv.org/api/query?search_query={}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=5",
            q
        );
        let c = client.clone();
        async move {
            let resp = c.get(&url).send().await.ok()?;
            let xml = resp.text().await.ok()?;
            Some(parse_arxiv_xml(&xml))
        }
    }).collect();

    let results = futures::future::join_all(futures).await;

    let mut all_papers: Vec<ArxivPaper> = results
        .into_iter()
        .filter_map(|r| r)
        .flatten()
        .collect();

    all_papers.sort_by(|a, b| b.published.cmp(&a.published));
    all_papers.dedup_by(|a, b| a.id == b.id);

    Ok(all_papers.into_iter().take(15).collect())
}

// `save_project_session` / `load_project_session` are async + spawn_blocking
// for the same reason every other fs-touching Tauri command in this codebase
// is: a sync handler would run on the NSApp main thread and freeze the UI
// while the syscall blocked. `load_project_session` is part of the boot
// cascade — its previous sync form was contributing to the warm-start
// beachball.
#[tauri::command]
pub async fn save_project_session(
    project_path: String,
    session_data: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let atlas_dir = Path::new(&project_path).join(".atlas");
        fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;
        let session_path = atlas_dir.join("session.json");
        fs::write(&session_path, &session_data).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn load_project_session(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let session_path = Path::new(&project_path).join(".atlas").join("session.json");
        if session_path.exists() {
            fs::read_to_string(&session_path).map_err(|e| e.to_string())
        } else {
            Ok("{}".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let close = format!("</{}>", tag);
    if let Some(start_pos) = xml.find(&open) {
        let after_open = &xml[start_pos..];
        if let Some(gt) = after_open.find('>') {
            let content_start = start_pos + gt + 1;
            if let Some(end_pos) = xml[content_start..].find(&close) {
                return Some(xml[content_start..content_start + end_pos].to_string());
            }
        }
    }
    None
}
