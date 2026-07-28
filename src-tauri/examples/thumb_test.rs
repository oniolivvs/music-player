// Print the thumbnail URLs a real search returns, then HEAD-check what the
// netThumb query-strip turns them into — diagnoses "covers never load".
fn main() {
    let q = std::env::args().nth(1).unwrap_or_else(|| "Ado".into());
    let hits = tauri::async_runtime::block_on(music_player_lib::ytnative::search(&q, 6, 0)).expect("search failed");
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build();
    for t in hits {
        let clean = if t.thumbnail.contains("i.ytimg.com/vi/") { t.thumbnail.split('?').next().unwrap().to_string() } else { t.thumbnail.clone() };
        let status = agent.get(&clean).call().map(|r| { let ct = r.header("Content-Type").unwrap_or("?").to_string(); format!("{} {}", r.status(), ct) }).unwrap_or_else(|e| format!("ERR {}", e.to_string().chars().take(60).collect::<String>()));
        println!("{}\n  raw:   {}\n  clean: {} -> {}", t.title.chars().take(40).collect::<String>(), t.thumbnail, clean, status);
    }
}
