//! Creates the native child window that mpv paints into.
//!
//! Strategy:
//! - Take the Tauri main window's HWND (the outer shell that contains the
//!   WebView2 composition).
//! - Register a trivial window class once per process.
//! - `CreateWindowExW` with `WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS`,
//!   parented to the Tauri HWND. This makes the mpv surface a sibling of
//!   the WebView2 HWND.
//! - mpv consumes its `--wid=<HWND>` flag and draws its video output there.
//! - The frontend reports the on-screen rect of its player div via a
//!   Tauri command; we `SetWindowPos` the child to match. WebView2's
//!   compositor paints the HTML UI *around* the child window; the video
//!   surface sits at the reported coordinates like a cut-out.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use tokio::sync::mpsc;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM, COLORREF};
use windows::Win32::Graphics::Gdi::{CreateSolidBrush, HBRUSH};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, CreateWindowExW, DefWindowProcW, RegisterClassExW, SetWindowPos,
    ShowWindow, CS_DBLCLKS, CS_HREDRAW, CS_VREDRAW, HCURSOR, HICON, HWND_TOP, SWP_NOACTIVATE,
    SWP_NOMOVE, SWP_NOSIZE, SW_HIDE, SW_SHOW, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE,
    WM_LBUTTONDBLCLK, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
};

use crate::err;
use crate::error::Result;

/// Signal bus for messages the child HWND's wnd_proc wants to ship out to
/// Tauri/frontend. Set once at mpv_init time; wnd_proc is the producer.
static EVENT_TX: OnceLock<mpsc::UnboundedSender<HwndEvent>> = OnceLock::new();

#[derive(Debug, Clone, Copy)]
pub enum HwndEvent {
    DoubleClick,
}

/// Install the sink the wnd_proc will push events into. Called once from
/// `mpv_init`. Any subsequent calls are ignored (OnceLock semantics).
pub fn set_event_sink(tx: mpsc::UnboundedSender<HwndEvent>) {
    let _ = EVENT_TX.set(tx);
}

/// Class name for the mpv host window. Registered lazily.
const CLASS_NAME: &str = "LumenMpvHost\0";

static CLASS_REGISTERED: AtomicBool = AtomicBool::new(false);

/// Register the window class the first time we're called. Idempotent.
/// Safe to race: a second RegisterClassExW with the same name errors with
/// ERROR_CLASS_ALREADY_EXISTS, which we ignore.
fn ensure_class_registered() {
    if CLASS_REGISTERED.load(Ordering::Acquire) {
        return;
    }
    unsafe {
        let class_name = to_wide(CLASS_NAME);
        // Solid black background so the video region doesn't flash white
        // before mpv's first frame lands.
        let bg: HBRUSH = CreateSolidBrush(COLORREF(0x000000));
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            // CS_DBLCLKS is required for Windows to even generate
            // WM_LBUTTONDBLCLK — without it, double-clicks arrive as two
            // WM_LBUTTONDOWN/UP pairs and fullscreen toggle can't hook in.
            style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: Default::default(),
            hIcon: HICON::default(),
            hCursor: HCURSOR::default(),
            hbrBackground: bg,
            lpszMenuName: PCWSTR::null(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            hIconSm: HICON::default(),
        };
        let atom = RegisterClassExW(&wc);
        if atom == 0 {
            // ERROR_CLASS_ALREADY_EXISTS is fine; anything else would
            // surface on CreateWindowExW.
            tracing::debug!(target: "lumen_lib", "RegisterClassExW returned 0 (already exists?)");
        }
    }
    CLASS_REGISTERED.store(true, Ordering::Release);
}

/// Create a child HWND inside `parent`, initially hidden and 1×1. The
/// frontend will call `set_geometry` once it knows where the video panel
/// ended up. Return value is the raw handle as `isize` — mpv's `--wid`
/// expects an integer and we'd rather not propagate windows types into
/// the IPC layer.
pub fn create_child(parent: isize) -> Result<isize> {
    ensure_class_registered();
    let class_name = to_wide(CLASS_NAME);
    let title = to_wide("mpv\0");
    unsafe {
        // Start at a real size (640×360) and visible. mpv's video-output
        // binds its swap chain to the HWND's client size at spawn time; a
        // 1×1 hidden window makes the D3D11 vo initialize with a degenerate
        // surface that never recovers when we SetWindowPos later — hello,
        // permanent black rect. 640×360 is a safe "video-shaped" starting
        // size; the frontend's geometry push will resize to the real rect
        // within the first React effect tick.
        // Position off-screen (-20000,-20000) at a real 640×360 size. mpv
        // still gets a valid non-degenerate swap chain for its GL context,
        // but the HWND isn't over any UI — so clicks pass through to
        // WebView2 until the frontend calls set_geometry with the actual
        // video-box rect. Without this, the child sits at (0,0)640×360
        // on top of Z-order and swallows clicks in the sidebar.
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(title.as_ptr()),
            WS_CHILD | WS_CLIPSIBLINGS | WS_VISIBLE,
            -20000,
            -20000,
            640,
            360,
            HWND(parent as *mut _),
            None,
            None,
            None,
        )
        .map_err(|e| err!("CreateWindowExW failed for mpv child: {}", e))?;
        if hwnd.0.is_null() {
            return Err(err!("CreateWindowExW returned null HWND"));
        }
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        // Raise above WebView2. Tauri's shell contains WebView2 and our
        // mpv child as siblings; default Z-order is creation-order, so
        // without this the WebView2 HWND (created first) paints over us
        // and the user sees a black rectangle exactly where mpv is
        // happily decoding frames. HWND_TOP puts us at the top of the
        // sibling Z-order — native child windows above this one will
        // still show, but WebView2's opaque surface won't eat our video.
        let _ = SetWindowPos(
            hwnd,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        let _ = BringWindowToTop(hwnd);
        Ok(hwnd.0 as isize)
    }
}

/// Resize and move the child to `x,y,w,h` in parent-window client pixels.
/// Frontend sends these as CSS pixels × devicePixelRatio. If width or
/// height is zero we hide the window instead; mpv tolerates that.
pub fn set_geometry(child: isize, x: i32, y: i32, w: i32, h: i32) -> Result<()> {
    let hwnd = HWND(child as *mut _);
    unsafe {
        if w <= 0 || h <= 0 {
            let _ = ShowWindow(hwnd, SW_HIDE);
            return Ok(());
        }
        // Caller passes CSS pixels (getBoundingClientRect from the WebView2
        // viewport). SetWindowPos expects physical client pixels. On a
        // scaled display (125%, 150%) those diverge — passing CSS px
        // straight through undersizes the child HWND and leaves the video
        // off where WebView2 paints its opaque canvas over it. Query the
        // monitor DPI for the child's HWND and scale to physical px.
        let dpi = GetDpiForWindow(hwnd);
        let scale = if dpi == 0 { 1.0 } else { dpi as f64 / 96.0 };
        let px = |v: i32| (v as f64 * scale).round() as i32;
        // HWND_TOP (not NOZORDER) — every geometry push re-asserts that
        // mpv's child sits above WebView2 in the sibling Z-order. Without
        // this, a WebView2 internal relayout can shove its HWND back on
        // top and we're black again.
        SetWindowPos(
            hwnd,
            HWND_TOP,
            px(x),
            px(y),
            px(w),
            px(h),
            SWP_NOACTIVATE,
        )
        .map_err(|e| err!("SetWindowPos failed: {}", e))?;
        let _ = ShowWindow(hwnd, SW_SHOW);
    }
    Ok(())
}

/// Window proc for the LumenMpvHost child.
///
/// mpv is a separate process that only uses our HWND as a DXGI swap-chain
/// target — it never pumps messages here. That means every WM_* for this
/// window is dispatched by the Tauri UI thread's pump (which created the
/// HWND), and we're the only code that can react. The native child sits
/// on top of WebView2 in Z-order, so HTML `onDoubleClick` on the React
/// side will never fire over the video rect either. Intercept
/// WM_LBUTTONDBLCLK here and signal the frontend out-of-band.
unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if msg == WM_LBUTTONDBLCLK {
        let sent = EVENT_TX.get().map(|tx| tx.send(HwndEvent::DoubleClick).is_ok()).unwrap_or(false);
        tracing::info!(target: "lumen_lib", "wnd_proc: WM_LBUTTONDBLCLK sent={}", sent);
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}
