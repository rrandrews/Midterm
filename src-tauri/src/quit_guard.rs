//! Routes every macOS "quit" through the webview's confirmation.
//!
//! Our ⌘Q menu item already asks the webview first (`menu::QUIT_ID`), but
//! AppKit also quits on its own: Quit from the Dock, logging out, shutting
//! down. Those call `-[NSApplication terminate:]`, which asks the app
//! delegate's `applicationShouldTerminate:`. Tao's delegate does not
//! implement it (so AppKit quits at once), so we add it: it cancels the
//! termination and emits `quit-requested`, and the webview calls `app_quit`
//! once the user has agreed. `app_quit` sets [`QUITTING`] first, so if
//! exiting goes through `terminate:` again it is let through.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter};

/// Set when quitting has been confirmed: termination is no longer stopped.
pub static QUITTING: AtomicBool = AtomicBool::new(false);

static APP: OnceLock<AppHandle> = OnceLock::new();

#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) {
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{MainThreadMarker, ffi, sel};
    use objc2_app_kit::NSApplication;

    // NSApplicationTerminateReply
    const TERMINATE_CANCEL: usize = 0;
    const TERMINATE_NOW: usize = 1;

    unsafe extern "C-unwind" fn should_terminate(
        _this: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        if QUITTING.load(Ordering::SeqCst) {
            return TERMINATE_NOW;
        }
        // No webview to ask: do not hold up a logout or shutdown.
        match APP.get() {
            Some(app) if app.emit("quit-requested", ()).is_ok() => TERMINATE_CANCEL,
            _ => TERMINATE_NOW,
        }
    }

    let _ = APP.set(app.clone());
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("quit_guard: not on the main thread; Dock Quit will not ask first");
        return;
    };
    let Some(delegate) = NSApplication::sharedApplication(mtm).delegate() else {
        eprintln!("quit_guard: no app delegate; Dock Quit will not ask first");
        return;
    };
    let object: &AnyObject = delegate.as_ref();
    let class = object.class() as *const AnyClass as *mut AnyClass;
    // SAFETY: the function matches the selector's signature
    // (`- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender`,
    // type encoding `Q@:@`). If the class already implements it, nothing is
    // added and AppKit keeps using the existing method.
    let added = unsafe {
        let imp: Imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            Imp,
        >(should_terminate);
        ffi::class_addMethod(
            class,
            sel!(applicationShouldTerminate:),
            imp,
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        eprintln!("quit_guard: delegate already handles termination; Dock Quit will not ask first");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
}
