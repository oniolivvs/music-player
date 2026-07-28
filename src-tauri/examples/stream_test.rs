//! Headless check of the HTTP streaming pipeline: opens a remote audio URL with
//! HttpStream and decodes samples through rodio, without needing an audio device
//! or the GUI. Usage: cargo run --example stream_test -- <direct-audio-url>

#[path = "../src/stream.rs"]
mod stream;

use rodio::{Decoder, Source};
use std::io::{Read, Seek, SeekFrom};
use stream::HttpStream;

struct LogStream(HttpStream);
impl Read for LogStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let r = self.0.read(buf);
        if let Err(e) = &r {
            eprintln!("[read err] {e}");
        }
        r
    }
}
impl Seek for LogStream {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        let r = self.0.seek(from);
        eprintln!("[seek] {from:?} -> {r:?}");
        r
    }
}

fn main() {
    let url = std::env::args().nth(1).expect("usage: stream_test <url>");
    let s = HttpStream::open(url).expect("HttpStream::open failed");
    let len = s.byte_len();
    let dec = Decoder::builder()
        .with_data(LogStream(s))
        .with_byte_len(len)
        .with_seekable(true)
        .build()
        .expect("decoder build failed (unsupported codec?)");
    println!(
        "decoder ok — rate={} channels={} duration={:?}",
        dec.sample_rate(),
        dec.channels(),
        dec.total_duration()
    );
    let n = dec.take(44100 * 10).count(); // ~10s worth of samples
    assert!(n > 0, "no samples decoded");
    println!("decoded {n} samples from the network stream — OK");
}
