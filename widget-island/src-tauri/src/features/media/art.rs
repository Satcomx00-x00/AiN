//! Cover art as `data:` URLs, for players that hand out a file or a link rather than the image.

use base64::{Engine, engine::general_purpose::STANDARD};

pub const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// "image/png" for ".png", and so on; JPEG when unsure, since most cover art is.
pub fn mime_for(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    match lower.rsplit('.').next() {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        _ => "image/jpeg",
    }
}

/// The image type from its first bytes; JPEG when unsure.
pub fn sniff(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [b'G', b'I', b'F', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ => "image/jpeg",
    }
}

pub fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

/// An http(s) image, fetched.
pub fn download(url: &str) -> Option<String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return None;
    }
    let mut response = ureq::get(url).call().ok()?;
    let mime = response.body().mime_type().map_or_else(|| mime_for(url).to_string(), str::to_string);
    let bytes = response.body_mut().with_config().limit(MAX_BYTES).read_to_vec().ok()?;
    Some(data_url(&mime, &bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_image_types() {
        assert_eq!(mime_for("/tmp/Cover.PNG"), "image/png");
        assert_eq!(mime_for("https://i.scdn.co/image/ab67616d0000b273"), "image/jpeg");
    }

    #[test]
    fn recognizes_images_by_their_bytes() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n"), "image/png");
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), "image/webp");
        assert_eq!(sniff(&[0xff, 0xd8, 0xff]), "image/jpeg");
    }

    #[test]
    fn only_downloads_web_links() {
        assert_eq!(download("file:///etc/passwd"), None);
    }
}
