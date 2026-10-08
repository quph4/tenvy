//! How this copy of Tenvy was installed. The Microsoft Store version runs
//! as an MSIX package and is updated by the Store, so it must never update
//! itself (that would install a second, separate copy next to it).

use std::sync::OnceLock;

/// True when running as an installed MSIX package (the Store version).
pub fn is_store() -> bool {
    static STORE: OnceLock<bool> = OnceLock::new();
    *STORE.get_or_init(has_package_identity)
}

#[cfg(windows)]
fn has_package_identity() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentPackageFullName(length: *mut u32, name: *mut u16) -> i32;
    }
    const APPMODEL_ERROR_NO_PACKAGE: i32 = 15700;
    let mut length = 0u32;
    // With no buffer this only reports the name's length — or that there
    // is no package at all.
    let status = unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) };
    status != APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(not(windows))]
fn has_package_identity() -> bool {
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_plain_test_binary_is_not_the_store_version() {
        assert!(!super::is_store());
    }
}
