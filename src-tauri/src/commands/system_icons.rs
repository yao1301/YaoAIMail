//! Native file-association icons for attachment display.
//! Windows uses Shell32/GDI; other platforms return None and the UI keeps its
//! MIME/file-type fallback icon.

#[tauri::command]
pub fn get_system_file_icon(path: String) -> Option<String> {
    #[cfg(windows)]
    { return windows_icon(&path); }
    #[cfg(not(windows))]
    { let _ = path; None }
}

#[cfg(windows)]
fn windows_icon(path: &str) -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr::null_mut;

    type Hicon = *mut core::ffi::c_void;
    type Hbitmap = *mut core::ffi::c_void;
    type Hdc = *mut core::ffi::c_void;
    type Hinstance = *mut core::ffi::c_void;
    type Hgd = *mut core::ffi::c_void;
    #[repr(C)] struct FileInfo { icon: Hicon, index: i32, attributes: u32, display: [u16; 260], type_name: [u16; 80] }
    #[repr(C)] struct IconInfo { f_icon: i32, x_hotspot: u32, y_hotspot: u32, mask: Hbitmap, color: Hbitmap }
    #[repr(C)] struct Bih { size: u32, width: i32, height: i32, planes: u16, bit_count: u16, compression: u32, size_image: u32, x: i32, y: i32, clr_used: u32, clr_important: u32 }
    #[repr(C)] struct Bmi { header: Bih, colors: [u32; 1] }
    extern "system" {
        fn SHGetFileInfoW(path: *const u16, attrs: u32, info: *mut FileInfo, size: u32, flags: u32) -> usize;
        fn GetDC(hwnd: *mut core::ffi::c_void) -> Hdc;
        fn ReleaseDC(hwnd: *mut core::ffi::c_void, dc: Hdc) -> i32;
        fn CreateCompatibleDC(dc: Hdc) -> Hdc;
        fn DeleteDC(dc: Hdc) -> i32;
        fn CreateCompatibleBitmap(dc: Hdc, width: i32, height: i32) -> Hbitmap;
        fn SelectObject(dc: Hdc, obj: Hgd) -> Hgd;
        fn DeleteObject(obj: Hgd) -> i32;
        fn DrawIconEx(dc: Hdc, x: i32, y: i32, icon: Hicon, width: i32, height: i32, step: u32, brush: Hgd, flags: u32) -> i32;
        fn GetDIBits(dc: Hdc, bitmap: Hbitmap, start: u32, lines: u32, bits: *mut u8, bmi: *mut Bmi, usage: u32) -> i32;
        fn DestroyIcon(icon: Hicon) -> i32;
    }
    const SHGFI_ICON: u32 = 0x100;
    const SHGFI_LARGEICON: u32 = 0x0;
    const SHGFI_USEFILEATTRIBUTES: u32 = 0x10;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const DIB_RGB_COLORS: u32 = 0;
    const DI_NORMAL: u32 = 0x3;
    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect();
    let mut file_info = FileInfo { icon: null_mut(), index: 0, attributes: 0, display: [0; 260], type_name: [0; 80] };
    let (attributes, attribute_flag) = if std::path::Path::new(path).is_file() { (0, 0) } else { (FILE_ATTRIBUTE_NORMAL, SHGFI_USEFILEATTRIBUTES) };
    if unsafe { SHGetFileInfoW(wide.as_ptr(), attributes, &mut file_info, core::mem::size_of::<FileInfo>() as u32, SHGFI_ICON | SHGFI_LARGEICON | attribute_flag) } == 0 || file_info.icon.is_null() { return None; }
    let screen = unsafe { GetDC(null_mut()) };
    let mem = unsafe { CreateCompatibleDC(screen) };
    let bitmap = unsafe { CreateCompatibleBitmap(screen, 32, 32) };
    if screen.is_null() || mem.is_null() || bitmap.is_null() { unsafe { DestroyIcon(file_info.icon); } return None; }
    let old = unsafe { SelectObject(mem, bitmap as Hgd) };
    unsafe { DrawIconEx(mem, 0, 0, file_info.icon, 32, 32, 0, null_mut(), DI_NORMAL); }
    let mut bmi = Bmi { header: Bih { size: 40, width: 32, height: -32, planes: 1, bit_count: 32, compression: 0, size_image: 0, x: 0, y: 0, clr_used: 0, clr_important: 0 }, colors: [0] };
    let mut pixels = vec![0u8; 32 * 32 * 4];
    let ok = unsafe { GetDIBits(mem, bitmap, 0, 32, pixels.as_mut_ptr(), &mut bmi, DIB_RGB_COLORS) } > 0;
    unsafe { SelectObject(mem, old); DeleteObject(bitmap as Hgd); DeleteDC(mem); ReleaseDC(null_mut(), screen); DestroyIcon(file_info.icon); }
    if !ok { return None; }
    // BMP is supported by WebView2 and avoids adding an image/PNG dependency.
    let mut bmp = Vec::with_capacity(54 + pixels.len());
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&(54u32 + pixels.len() as u32).to_le_bytes());
    bmp.extend_from_slice(&[0; 4]); bmp.extend_from_slice(&(54u32).to_le_bytes());
    bmp.extend_from_slice(&40u32.to_le_bytes()); bmp.extend_from_slice(&32i32.to_le_bytes()); bmp.extend_from_slice(&(-32i32).to_le_bytes());
    bmp.extend_from_slice(&1u16.to_le_bytes()); bmp.extend_from_slice(&32u16.to_le_bytes()); bmp.extend_from_slice(&[0; 24]); bmp.extend_from_slice(&pixels);
    Some(format!("data:image/bmp;base64,{}", base64_encode(&bmp)))
}

#[cfg(windows)]
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = if chunk.len() > 1 { ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | chunk.get(2).copied().unwrap_or(0) as u32 } else { (chunk[0] as u32) << 16 };
        out.push(TABLE[((n >> 18) & 63) as usize] as char); out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}
