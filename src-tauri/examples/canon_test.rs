// Headless check of path canonicalization (run inside the dev container where
// /home and /var/home are separate bind mounts of the same directory).
fn main() {
    for a in std::env::args().skip(1) {
        println!("{a} -> {}", music_player_lib::library::canon(&a));
    }
}
