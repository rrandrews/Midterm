//! Places the macOS traffic lights inside the app's own title bar.
//!
//! Tauri's `trafficLightPosition` only moves the buttons horizontally and
//! resizes the title-bar container. Their vertical position stays wherever
//! AppKit put them, which changes between macOS releases (newer releases use
//! larger buttons). So we lay them out ourselves: vertically centred in the
//! web title bar (`--titlebar-height` in `src/styles/index.css`), starting
//! `INSET_X` from the left edge, with AppKit's own spacing between them.
//!
//! AppKit resets the layout on some events (resize, leaving fullscreen,
//! focus changes), so `lib.rs` calls `apply` again after each of those.

use tauri::Window;

/// Height of the web title bar, without its 1px bottom border.
const BAR_HEIGHT: f64 = 38.0;
/// Distance from the window's left edge to the close button.
const INSET_X: f64 = 14.0;

#[cfg(target_os = "macos")]
pub fn apply(window: &Window) {
    let target = window.clone();
    // AppKit views may only be touched on the main thread.
    let _ = window.run_on_main_thread(move || layout(&target));
}

#[cfg(not(target_os = "macos"))]
pub fn apply(_window: &Window) {}

#[cfg(target_os = "macos")]
fn layout(window: &Window) {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
    use objc2_foundation::{NSPoint, NSRect};

    let Ok(ptr) = window.ns_window() else { return };
    // SAFETY: Tauri hands back the live NSWindow for this window, and we are
    // on the main thread.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };

    // In fullscreen the buttons live in a separate, system-managed toolbar
    // window; leave them alone.
    if ns_window.styleMask().contains(NSWindowStyleMask::FullScreen) {
        return;
    }

    let buttons = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|kind| ns_window.standardWindowButton(kind));
    let [Some(close), Some(minimize), Some(zoom)] = buttons else { return };

    // close → NSTitlebarView → NSTitlebarContainerView
    let Some(titlebar) = (unsafe { close.superview() }) else { return };
    let Some(container) = (unsafe { titlebar.superview() }) else { return };

    // Make the native title bar exactly as tall as ours, pinned to the top.
    let window_height = ns_window.frame().size.height;
    let mut frame = container.frame();
    frame.origin.y = window_height - BAR_HEIGHT;
    frame.size.height = BAR_HEIGHT;
    container.setFrame(frame);
    titlebar.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        objc2_foundation::NSSize::new(frame.size.width, BAR_HEIGHT),
    ));

    let spacing = minimize.frame().origin.x - close.frame().origin.x;
    for (i, button) in [close, minimize, zoom].iter().enumerate() {
        let height = button.frame().size.height;
        // Centred, so it does not matter whether the view is flipped.
        let y = ((BAR_HEIGHT - height) / 2.0).round();
        button.setFrameOrigin(NSPoint::new(INSET_X + i as f64 * spacing, y));
    }
}
