//! Desktop-only download and player helpers; query APIs are shared with the server CLI.
pub use weiyu_core::bilibili::*;

pub mod download;
pub mod nfo;
pub mod filename;
pub mod mp4_seek;
