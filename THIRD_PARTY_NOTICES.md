# Third-party software

Lumen bundles the following independently licensed programs. They run as
separate processes and are distributed alongside Lumen, not linked into it.

## mpv

- Project: https://mpv.io — source: https://github.com/mpv-player/mpv
- Windows build: https://github.com/shinchiro/mpv-winbuild-cmake
- License: GPL-2.0-or-later (the Windows builds include GPL components; see
  `Copyright` / `LICENSE.GPL` in the mpv source tree).

The exact mpv version shipped is printed by `mpv/mpv.exe --version` in the
install directory. The corresponding source code is available at the links
above; a copy for the shipped version can also be requested from the Lumen
publisher.

<!-- TODO before first public release: include the full mpv license text
     in the installer, and pin the mpv build (version + SHA256) used for
     each release in scripts/fetch-mpv.ps1 / CI. -->

## Frontend and Rust dependencies

Lumen's own JavaScript and Rust dependencies are permissively licensed
(MIT / Apache-2.0 / BSD / ISC / Zlib / Unicode). A generated list can be
produced with `cargo about` (Rust) and `pnpm licenses list` (JavaScript).
