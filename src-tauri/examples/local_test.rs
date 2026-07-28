//! Headless check of the local-file decode path after the rodio 0.21 migration:
//! same DecoderBuilder settings as audio::append_track, plus a seek, without
//! needing an audio device. Usage: cargo run --example local_test -- <file>

use rodio::{Decoder, Source};
use std::fs::File;
use std::io::BufReader;
use std::time::Duration;

fn main() {
    let path = std::env::args().nth(1).expect("usage: local_test <file>");
    let f = File::open(&path).expect("open failed");
    let len = f.metadata().map(|m| m.len()).ok();
    let mut b = Decoder::builder()
        .with_data(BufReader::new(f))
        .with_seekable(true);
    if let Some(l) = len {
        b = b.with_byte_len(l);
    }
    let mut dec = b.build().expect("decoder build failed");
    println!(
        "decoder ok — rate={} channels={} duration={:?}",
        dec.sample_rate(),
        dec.channels(),
        dec.total_duration()
    );
    dec.try_seek(Duration::from_secs(30)).expect("seek failed");
    let n = dec.take(44100).count();
    assert!(n > 0, "no samples decoded after seek");
    println!("seek to 30s + decoded {n} samples — OK");
}
