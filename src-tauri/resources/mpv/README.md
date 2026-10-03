# Bundled mpv

The installer ships mpv from this folder; Tenvy runs `mpv/mpv.exe` from
its resource directory before falling back to a system install.

The binaries are not committed. Populate the folder before `pnpm tauri build`:

    powershell -ExecutionPolicy Bypass -File scripts/fetch-mpv.ps1   # copy from a local install
    powershell -ExecutionPolicy Bypass -File scripts/fetch-mpv.ps1 -Url <7z> -Sha256 <hash>   # CI

mpv is licensed under the GPL/LGPL — ship its license text with releases
and link to the exact source (see THIRD_PARTY_NOTICES.md).
