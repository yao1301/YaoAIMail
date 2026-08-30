use base64::Engine;

#[cfg(target_os = "windows")]
fn read_i32(bytes: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?))
}

#[cfg(target_os = "windows")]
fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?))
}

#[cfg(target_os = "windows")]
fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(offset..offset + 4)?.try_into().ok()?))
}

#[cfg(target_os = "windows")]
fn dib_to_png(dib: &[u8]) -> Result<Vec<u8>, String> {
    if dib.len() < 40 {
        return Err("剪贴板位图数据不完整".to_string());
    }
    let header_size = read_u32(dib, 0).ok_or("无法读取位图头")? as usize;
    let width = read_i32(dib, 4).ok_or("无法读取位图宽度")?;
    let signed_height = read_i32(dib, 8).ok_or("无法读取位图高度")?;
    let planes = read_u16(dib, 12).ok_or("无法读取位图平面")?;
    let bit_count = read_u16(dib, 14).ok_or("无法读取位图颜色深度")?;
    let compression = read_u32(dib, 16).ok_or("无法读取位图压缩方式")?;
    let colors_used = read_u32(dib, 32).unwrap_or(0) as usize;
    if width <= 0 || signed_height == 0 || planes != 1 {
        return Err("剪贴板位图尺寸无效".to_string());
    }
    if !matches!(bit_count, 24 | 32) || compression != 0 {
        return Err(format!("暂不支持的剪贴板位图格式：{bit_count} 位 / 压缩 {compression}"));
    }

    let width = width as usize;
    let height = signed_height.unsigned_abs() as usize;
    let palette_bytes = if bit_count <= 8 {
        (if colors_used == 0 { 1usize << bit_count } else { colors_used }) * 4
    } else {
        0
    };
    let pixel_offset = header_size.checked_add(palette_bytes).ok_or("位图偏移溢出")?;
    let row_stride = ((width * bit_count as usize + 31) / 32) * 4;
    let required = pixel_offset
        .checked_add(row_stride.checked_mul(height).ok_or("位图尺寸过大")?)
        .ok_or("位图尺寸过大")?;
    if required > dib.len() {
        return Err("剪贴板位图像素数据不完整".to_string());
    }

    let color = if bit_count == 32 { png::ColorType::Rgba } else { png::ColorType::Rgb };
    let channels = if bit_count == 32 { 4 } else { 3 };
    let mut pixels = vec![0u8; width * height * channels];
    let top_down = signed_height < 0;
    for output_y in 0..height {
        let source_y = if top_down { output_y } else { height - 1 - output_y };
        let source_row = pixel_offset + source_y * row_stride;
        let output_row = output_y * width * channels;
        for x in 0..width {
            let source = source_row + x * (bit_count as usize / 8);
            let output = output_row + x * channels;
            pixels[output] = dib[source + 2];
            pixels[output + 1] = dib[source + 1];
            pixels[output + 2] = dib[source];
            if channels == 4 {
                // Office DIB alpha bytes are commonly all zero even though the
                // bitmap is opaque. Treat them as opaque to avoid invisible paste.
                pixels[output + 3] = 255;
            }
        }
    }

    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width as u32, height as u32);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| format!("PNG 编码失败：{e}"))?;
        writer.write_image_data(&pixels).map_err(|e| format!("PNG 编码失败：{e}"))?;
    }
    Ok(png_bytes)
}

#[cfg(target_os = "windows")]
fn windows_clipboard_image_png() -> Result<Option<Vec<u8>>, String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::CF_DIB;

    unsafe { OpenClipboard(None) }.map_err(|e| format!("无法读取 Windows 剪贴板：{e}"))?;
    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe { let _ = CloseClipboard(); }
        }
    }
    let _guard = ClipboardGuard;

    if unsafe { IsClipboardFormatAvailable(CF_DIB.0 as u32) }.is_err() {
        return Ok(None);
    }
    let handle = unsafe { GetClipboardData(CF_DIB.0 as u32) }
        .map_err(|e| format!("无法取得剪贴板位图：{e}"))?;
    let global = HGLOBAL(handle.0 as *mut std::ffi::c_void);
    let size = unsafe { GlobalSize(global) };
    let ptr = unsafe { GlobalLock(global) };
    if ptr.is_null() || size == 0 {
        return Err("无法锁定剪贴板位图".to_string());
    }
    let dib = unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), size) };
    let result = dib_to_png(dib);
    unsafe { let _ = GlobalUnlock(global); }
    result.map(Some)
}

/// Read the rendered bitmap that Excel places on the native Windows clipboard.
/// The WebView paste event frequently exposes only HTML and hides this image.
#[tauri::command]
pub fn get_clipboard_image_png_base64() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        return windows_clipboard_image_png().map(|image| {
            image.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::dib_to_png;

    #[test]
    fn converts_bottom_up_24_bit_dib_to_png() {
        let mut dib = vec![0u8; 40 + 8];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&2i32.to_le_bytes());
        dib[8..12].copy_from_slice(&1i32.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        dib[40..46].copy_from_slice(&[0, 0, 255, 0, 255, 0]);
        let png = dib_to_png(&dib).expect("DIB should encode");
        assert_eq!(&png[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    }
}
