use serde::Serialize;
use std::fs;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct GithubRepo {
    pub name: String,
    pub full_name: String,
    pub description: String,
    pub html_url: String,
    pub clone_url: String,
    pub language: String,
    pub stars: u32,
    pub forks: u32,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClonedRepo {
    pub name: String,
    pub path: String,
    pub has_readme: bool,
}

#[tauri::command]
pub async fn search_github(query: String) -> Result<Vec<GithubRepo>, String> {
    let url = format!(
        "https://api.github.com/search/repositories?q={}&sort=stars&order=desc&per_page=20",
        urlencoded(&query)
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Atlas-IDE")
        .build()
        .unwrap_or_default();

    let resp = client.get(&url).send().await
        .map_err(|e| format!("GitHub API request failed: {}", e))?;

    let json: serde_json::Value = resp.json().await
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let items = json.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();

    let repos = items.iter().map(|item| {
        GithubRepo {
            name: item.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            full_name: item.get("full_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            description: item.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            html_url: item.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            clone_url: item.get("clone_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            language: item.get("language").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            stars: item.get("stargazers_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            forks: item.get("forks_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
            updated_at: item.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        }
    }).collect();

    Ok(repos)
}

#[tauri::command]
pub async fn clone_github_repo(
    project_path: String,
    clone_url: String,
    repo_name: String,
) -> Result<String, String> {
    let repos_dir = Path::new(&project_path).join(".atlas").join("repos");
    fs::create_dir_all(&repos_dir).map_err(|e| e.to_string())?;

    let dest = repos_dir.join(&repo_name);
    if dest.exists() {
        return Err(format!("Repository '{}' already cloned", repo_name));
    }

    let dest_str = dest.to_string_lossy().to_string();
    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("git")
            .args(["clone", "--depth", "1", &clone_url, &dest_str])
            .output()
            .map_err(|e| format!("Git clone failed: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }
        Ok(dest_str)
    }).await.map_err(|e| e.to_string())?
}

// All async + spawn_blocking — see the comment in knowledge.rs for the
// reason (sync Tauri command handlers run on NSApp main thread).
#[tauri::command]
pub async fn list_cloned_repos(project_path: String) -> Result<Vec<ClonedRepo>, String> {
    tokio::task::spawn_blocking(move || {
        let repos_dir = Path::new(&project_path).join(".atlas").join("repos");
        if !repos_dir.exists() {
            return Ok(vec![]);
        }
        let mut repos = Vec::new();
        let read = fs::read_dir(&repos_dir).map_err(|e| e.to_string())?;
        for entry in read.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let has_readme =
                path.join("README.md").exists() || path.join("readme.md").exists();
            repos.push(ClonedRepo {
                name,
                path: path.to_string_lossy().to_string(),
                has_readme,
            });
        }
        repos.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(repos)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn read_repo_readme(
    project_path: String,
    repo_name: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let repo_dir = Path::new(&project_path)
            .join(".atlas")
            .join("repos")
            .join(&repo_name);
        for name in &[
            "README.md",
            "readme.md",
            "Readme.md",
            "README.rst",
            "README.txt",
            "README",
        ] {
            let path = repo_dir.join(name);
            if path.exists() {
                return fs::read_to_string(&path).map_err(|e| e.to_string());
            }
        }
        Err("No README found".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_cloned_repo(
    project_path: String,
    repo_name: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let repo_dir = Path::new(&project_path)
            .join(".atlas")
            .join("repos")
            .join(&repo_name);
        if repo_dir.exists() {
            fs::remove_dir_all(&repo_dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn urlencoded(s: &str) -> String {
    s.replace(' ', "+").replace('&', "%26").replace('=', "%3D").replace('?', "%3F")
}
